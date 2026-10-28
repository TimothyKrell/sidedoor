import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { getSecret, grokBotToken } from '../secrets'
import { getMeta, getSettings, setMeta } from '../settings'

/**
 * Work Sidedoor sends to Grok Bot. Grok Bot has no API for starting a task, so tasks sent to it
 * wait in the queue: Sidedoor wakes a Grok Bot routine through its webhook, the Bot takes the task
 * over MCP (`take_task`), does it with the app tools, and reports back (`finish_task`). The
 * bookkeeping after a task (activity, notifications, follow-on tasks) is the same as when an AI
 * runs it here.
 */

interface Work {
  prompt: string
  finish: (text: string) => Promise<void>
}

/** Task kinds Grok Bot can take, and the setting that sends each one to it. */
const HANDOFF: Partial<Record<schema.TaskKind, { setting: 'research' | 'x'; work: (t: schema.Task) => Promise<Work> }>> = {
  research: { setting: 'research', work: (t) => import('./tasks').then((m) => m.researchWork(t)) },
  'x-scout': { setting: 'x', work: (t) => import('./x-scout').then((m) => m.xScoutWork(t)) },
}

/** A task Grok Bot took and hasn't reported back on in this long goes back in the queue. */
export const STALE_MS = 2 * 3600_000
/** Wake the routine again for a task still waiting this long after the last wake. */
const REWAKE_MS = 30 * 60_000
const MAX_WAKES = 3
const MAX_TAKES = 3

/** Kinds that wait for Grok Bot right now. None unless it's turned on (it has a token). */
export const grokBotKinds = (): schema.TaskKind[] => {
  if (!grokBotToken()) return []
  const g = getSettings().grokBot
  return (Object.keys(HANDOFF) as schema.TaskKind[]).filter((k) => g[HANDOFF[k]!.setting])
}

const T = schema.tasks
const runnable = () => sql`(${T.runAfter} is null or ${T.runAfter} <= ${nowIso()})`

/** Mark a task failed and say so on Today. */
const fail = (task: schema.Task, error: string) => {
  db.update(T).set({ status: 'failed', error: error.slice(0, 4000), finishedAt: nowIso() }).where(eq(T.id, task.id)).run()
  logActivity('system', `Task failed: ${task.title}`, { detail: error.slice(0, 300), link: '/tasks' })
}

/**
 * Grok Bot takes a waiting task: the one named, or the next one. Returns its instructions, or null
 * when there's nothing to take.
 */
export const takeTask = async (id?: string) => {
  const kinds = grokBotKinds()
  if (!kinds.length) return null
  const task = db.transaction((tx) => {
    const next = tx
      .select()
      .from(T)
      .where(and(eq(T.status, 'queued'), inArray(T.kind, kinds), runnable(), ...(id ? [eq(T.id, id)] : [])))
      .orderBy(desc(T.priority), asc(T.createdAt))
      .get()
    if (!next) return null
    const startedAt = nowIso()
    tx.update(T).set({ status: 'running', provider: 'grokbot', model: null, startedAt, attempts: next.attempts + 1 }).where(eq(T.id, next.id)).run()
    return { ...next, status: 'running' as const, startedAt, attempts: next.attempts + 1 }
  })
  if (!task) return null
  setMeta('grokBotTookAt', nowIso())
  try {
    const w = await HANDOFF[task.kind]!.work(task)
    return { id: task.id, kind: task.kind, title: task.title, instructions: w.prompt }
  } catch (e) {
    fail(task, e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Grok Bot reports back on a task it took: a summary when it's done, or what went wrong. */
export const finishTask = async (id: string, r: { summary?: string; error?: string }) => {
  const task = db.select().from(T).where(eq(T.id, id)).get()
  if (!task) throw new Error('No such task.')
  if (task.status !== 'running' || task.provider !== 'grokbot') throw new Error(`This task is ${task.status}${task.status === 'running' ? ' here' : ''}, not waiting for Grok Bot. Take a task with take_task first.`)
  setMeta('grokBotFinishedAt', nowIso())
  if (r.error) return fail(task, `Grok Bot: ${r.error}`)
  const summary = r.summary?.trim() || '(no summary)'
  try {
    await HANDOFF[task.kind]!.work(task).then((w) => w.finish(summary))
  } catch (e) {
    return fail(task, e instanceof Error ? e.message : String(e))
  }
  db.update(T).set({ status: 'done', output: summary, finishedAt: nowIso() }).where(eq(T.id, id)).run()
}

export interface WakeState {
  at: string
  ok: boolean
  error?: string
}

/** Times each waiting task's routine was woken, so a slow Bot isn't woken every tick. */
const wakes = new Map<string, { at: number; n: number }>()

const post = async (url: string, key: string, body: unknown) => {
  const r = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) })
  if (!r.ok) throw new Error(`Grok Bot answered ${r.status}${r.status === 401 ? ' (check the key)' : r.status === 400 ? ' (is the routine paused?)' : ''}`)
}

/** Wake the routine for one task (or, with no task, just to test the webhook). */
export const wakeGrokBot = async (task?: Pick<schema.Task, 'id' | 'kind' | 'title'>) => {
  const url = getSettings().grokBot.webhookUrl.trim()
  const key = getSecret('grokbot-webhook-key')
  if (!url || !key) throw new Error('Add the routine’s webhook URL and key first.')
  const body = task
    ? { sidedoor: 'task', taskId: task.id, kind: task.kind, title: task.title }
    : { sidedoor: 'test', note: 'Sidedoor is checking this webhook. There is no task: reply that you got it and stop.' }
  try {
    await post(url, key, body)
    setMeta('grokBotWake', { at: nowIso(), ok: true } satisfies WakeState)
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    setMeta('grokBotWake', { at: nowIso(), ok: false, error } satisfies WakeState)
    throw e
  }
}

/**
 * Background tick: wake Grok Bot for tasks waiting for it, put back tasks it took and never
 * finished, and give up on ones it never picks up.
 */
export const grokBotTick = async () => {
  const kinds = grokBotKinds()
  if (!kinds.length) return
  const stale = db.select().from(T).where(and(eq(T.status, 'running'), eq(T.provider, 'grokbot'), lt(T.startedAt, new Date(Date.now() - STALE_MS).toISOString()))).all()
  for (const t of stale) {
    if (t.attempts >= MAX_TAKES) fail(t, `Grok Bot took this ${t.attempts} times without finishing it.`)
    else db.update(T).set({ status: 'queued', startedAt: null }).where(eq(T.id, t.id)).run()
  }
  const s = getSettings().grokBot
  if (!s.webhookUrl || !getSecret('grokbot-webhook-key')) return
  const waiting = db.select().from(T).where(and(eq(T.status, 'queued'), inArray(T.kind, kinds), runnable())).orderBy(desc(T.priority), asc(T.createdAt)).limit(5).all()
  for (const t of waiting) {
    const w = wakes.get(t.id)
    if (w && Date.now() - w.at < REWAKE_MS) continue
    if (w && w.n >= MAX_WAKES) {
      if (getMeta(`grokBotGaveUp:${t.id}`)) continue
      setMeta(`grokBotGaveUp:${t.id}`, nowIso())
      logActivity('system', `Grok Bot hasn't picked up: ${t.title}`, { detail: 'Check the routine in Grok Bot, or ask your Bot to "check Sidedoor".', link: '/settings?section=ai' })
      continue
    }
    wakes.set(t.id, { at: Date.now(), n: (w?.n ?? 0) + 1 })
    // A failed wake is recorded for Settings and tried again next time round.
    await wakeGrokBot(t).catch(() => undefined)
  }
}

let lastSeen = 0
/** Note that Grok Bot reached Sidedoor, at most every few minutes, so Settings can say it's connected. */
export const grokBotSeen = () => {
  if (Date.now() - lastSeen < 5 * 60_000) return
  lastSeen = Date.now()
  setMeta('grokBotSeenAt', nowIso())
}

/** What Settings shows about Grok Bot. */
export const grokBotStatus = () => {
  const kinds = Object.keys(HANDOFF) as schema.TaskKind[]
  const count = (status: 'queued' | 'running') =>
    db.select({ n: sql<number>`count(*)` }).from(T).where(and(eq(T.status, status), inArray(T.kind, kinds), ...(status === 'running' ? [eq(T.provider, 'grokbot')] : []))).get()?.n ?? 0
  return {
    waiting: grokBotKinds().length ? count('queued') : 0,
    working: count('running'),
    seenAt: getMeta<string>('grokBotSeenAt') ?? null,
    tookAt: getMeta<string>('grokBotTookAt') ?? null,
    finishedAt: getMeta<string>('grokBotFinishedAt') ?? null,
    wake: getMeta<WakeState>('grokBotWake') ?? null,
  }
}
