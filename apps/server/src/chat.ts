import { eq } from 'drizzle-orm'
import { chatCwd, mcpFor, resolveJobAi, runJob } from './ai'
import { logActivity } from './activity'
import { db, schema } from './db/client'
import { newId, nowIso } from './ids'
import { context, render, userName } from './prompts'
import { truncate } from './text'

export type ChatEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: string; isError: boolean }
  | { type: 'done'; costUsd: number }
  | { type: 'error'; message: string }

interface Turn {
  events: ChatEvent[]
  listeners: Set<(e: ChatEvent) => void>
  done: boolean
  abort: AbortController
}

// One in-flight turn per thread, kept across HMR reloads in dev.
const g = globalThis as unknown as { __sidedoorTurns?: Map<string, Turn> }
const turns: Map<string, Turn> = (g.__sidedoorTurns ??= new Map())

export const activeTurn = (threadId: string) => turns.get(threadId)

export const subscribe = (threadId: string, fn: (e: ChatEvent) => void) => {
  const t = turns.get(threadId)
  if (!t) return null
  for (const e of t.events) fn(e)
  if (t.done) return () => {}
  t.listeners.add(fn)
  return () => t.listeners.delete(fn)
}

export const stopTurn = (threadId: string) => turns.get(threadId)?.abort.abort()

/** Start a chat turn. Returns immediately; progress is published to subscribers and persisted. */
export type ChatMode = 'story'

export const startTurn = (v: { threadId?: string; message: string; pageContext?: string; pageLabel?: string; mode?: ChatMode; title?: string }) => {
  let thread = v.threadId ? db.select().from(schema.chatThreads).where(eq(schema.chatThreads.id, v.threadId)).get() : undefined
  if (!thread) {
    const id = newId('thr_')
    const context = { ...(v.pageContext ? { path: v.pageContext } : {}), ...(v.mode ? { mode: v.mode } : {}) }
    db.insert(schema.chatThreads).values({ id, title: truncate((v.title ?? v.message).replace(/\s+/g, ' '), 70), context: Object.keys(context).length ? context : null }).run()
    thread = db.select().from(schema.chatThreads).where(eq(schema.chatThreads.id, id)).get()!
  }
  const threadId = thread.id
  if (turns.get(threadId)?.done === false) throw new Error('Your AI is still answering in this thread')
  db.insert(schema.chatMessages).values({ id: newId('msg_'), threadId, role: 'user', parts: [{ type: 'text', text: v.message }], at: nowIso(), page: v.pageContext ?? null }).run()
  db.update(schema.chatThreads).set({ updatedAt: nowIso() }).where(eq(schema.chatThreads.id, threadId)).run()

  // Before registering the turn: with no AI connected this throws, and a registered turn would lock the thread.
  const ai = resolveJobAi('chat')
  const turn: Turn = { events: [], listeners: new Set(), done: false, abort: new AbortController() }
  turns.set(threadId, turn)
  const emit = (e: ChatEvent) => {
    turn.events.push(e)
    for (const l of turn.listeners) l(e)
  }

  // Story interviews get their own prompt and tools: the only thing they change is the story
  // bank, through the append-only save_story tool.
  const story = thread.context?.mode === 'story'
  const prompt = v.pageContext && !story ? `[${userName()} is looking at ${v.pageLabel ? `${v.pageLabel} — ` : ''}${v.pageContext}]\n\n${v.message}` : v.message
  // A session belongs to the AI that started it; switching AIs starts a fresh session.
  const resume = thread.sessionId && (thread.provider ?? 'claude') === ai.provider ? thread.sessionId : null

  void (async () => {
    const parts: schema.ChatPart[] = []
    const toolIndex = new Map<string, number>()
    let sessionId = resume
    let streamedText = ''
    let costUsd = 0
    const flushText = () => {
      if (streamedText.trim()) parts.push({ type: 'text', text: streamedText })
      streamedText = ''
    }
    try {
      const r = await runJob({
        job: 'chat',
        provider: ai.provider,
        model: ai.model,
        cwd: chatCwd(threadId),
        prompt,
        system: story ? render('story-interview', {}) : render('system', { CRITERIA: truncate(context.criteria(), 4000) }),
        web: !story,
        mcp: mcpFor(story ? 'story' : 'app'),
        maxTurns: 60,
        resume,
        signal: turn.abort.signal,
        onEvent: (e) => {
          if (e.type === 'text') {
            streamedText += e.delta
            emit(e)
          } else if (e.type === 'tool') {
            flushText()
            toolIndex.set(e.id, parts.length)
            parts.push({ type: 'tool', name: e.name, input: (e.input ?? {}) as schema.Json })
            emit(e)
          } else {
            const result = truncate(e.result, 1500)
            const idx = toolIndex.get(e.id)
            const part = idx !== undefined ? parts[idx] : undefined
            if (part?.type === 'tool') {
              part.result = result
              part.isError = e.isError
            }
            emit({ ...e, result })
          }
        },
      })
      sessionId = r.sessionId ?? sessionId
      costUsd = r.costUsd ?? 0
      // Providers that don't stream text deliver it at the end.
      if (!parts.some((p) => p.type === 'text') && !streamedText && r.text) {
        streamedText = r.text
        emit({ type: 'text', delta: r.text })
      }
    } catch (e) {
      flushText()
      const aborted = turn.abort.signal.aborted
      emit({ type: 'error', message: aborted ? 'Stopped.' : e instanceof Error ? e.message : String(e) })
    } finally {
      flushText()
      // Persist before announcing `done`: the client refetches the thread on `done` and drops its live copy.
      if (parts.length) db.insert(schema.chatMessages).values({ id: newId('msg_'), threadId, role: 'assistant', parts, at: nowIso() }).run()
      db.update(schema.chatThreads).set({ sessionId, provider: ai.provider, model: ai.model, updatedAt: nowIso() }).where(eq(schema.chatThreads.id, threadId)).run()
      emit({ type: 'done', costUsd })
      turn.done = true
      turn.listeners.clear()
      // Keep the finished turn briefly so a reconnecting client can replay it.
      setTimeout(() => turns.get(threadId) === turn && turns.delete(threadId), 60_000)
      const tools = parts.filter((p) => p.type === 'tool' && p.name.startsWith('mcp__sidedoor__') && !/overview|search|get_|list_|find_/.test(p.name)).length
      if (tools) logActivity('chat', `Your AI made ${tools} change${tools === 1 ? '' : 's'} from chat`, { detail: truncate(v.message, 120), link: `/chat/${threadId}` })
    }
  })()

  return { threadId }
}
