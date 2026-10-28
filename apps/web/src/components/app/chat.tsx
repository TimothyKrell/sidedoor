import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { ArrowUp, ChevronDown, ChevronRight, Loader2, Mic, Plus, Square, Wrench } from 'lucide-react'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '~/components/ui/dropdown-menu'
import { Textarea } from '~/components/ui/textarea'
import { qo } from '~/lib/api'
import { cn } from '~/lib/utils'
import { Markdown, TimeAgo } from './bits'

type Part = { type: 'text'; text: string } | { type: 'tool'; id?: string; name: string; input: unknown; result?: string; isError?: boolean }
interface Msg {
  id: string
  role: 'user' | 'assistant'
  parts: Part[]
}

// ---------------------------------------------------------------- page context + drawer state

interface ChatState {
  open: boolean
  threadId: string | null
  /** A request to send as soon as the chat opens (from one-tap actions like "Plan my day"). */
  autoSend: string | null
  clearAutoSend: () => void
  setOpen: (o: boolean) => void
  openChat: (o?: { send?: string; newThread?: boolean }) => void
  setThreadId: (id: string | null) => void
  pageContext: { path: string; label?: string } | null
  setPageContext: (c: { path: string; label?: string } | null) => void
}
const Ctx = createContext<ChatState | null>(null)

const THREAD_KEY = 'sidedoor.chat.thread'
/** page path → the chat last open there. */
const PAGE_KEY = 'sidedoor.chat.byPage'
const readPages = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(PAGE_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}
/** Pages with their own chats: arriving on one reopens its latest chat (or starts fresh). */
const ENTITY_PAGE = /^\/(applications|jobs|people)\//

export function ChatProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [threadId, setThreadIdState] = useState<string | null>(null)
  const [autoSend, setAutoSend] = useState<string | null>(null)
  const [pageContext, setPageContext] = useState<{ path: string; label?: string } | null>(null)
  // Bumped on every explicit choice, so a slow page lookup never overrides what the user picked.
  const choice = useRef(0)
  const setThreadId = useCallback((id: string | null) => {
    choice.current++
    setThreadIdState(id)
  }, [])
  // Survive reloads (the phone drops tabs; deploys restart the server).
  useEffect(() => {
    const saved = localStorage.getItem(THREAD_KEY)
    if (saved && choice.current === 0) setThreadIdState(saved)
  }, [])
  const path = pageContext?.path ?? null
  const lastPage = useRef<string | null>(null)
  useEffect(() => {
    if (threadId) localStorage.setItem(THREAD_KEY, threadId)
    else localStorage.removeItem(THREAD_KEY)
    // Only once the page's own lookup has run, so arriving doesn't record the previous page's chat.
    if (path && path === lastPage.current && ENTITY_PAGE.test(path)) {
      const pages = readPages()
      if (threadId) pages[path] = threadId
      else delete pages[path]
      localStorage.setItem(PAGE_KEY, JSON.stringify(Object.fromEntries(Object.entries(pages).slice(-200))))
    }
  }, [threadId, path])
  useEffect(() => {
    if (!path || path === lastPage.current) return
    if (!ENTITY_PAGE.test(path)) return void (lastPage.current = path)
    const at = choice.current
    const remembered = readPages()[path]
    void qc.fetchQuery(qo.panelThreads(path)).then((r) => {
      lastPage.current = path
      if (choice.current !== at) return
      const ids = new Set([...r.here, ...r.recent].map((t) => t.id))
      setThreadIdState(remembered && ids.has(remembered) ? remembered : (r.here[0]?.id ?? null))
    }, () => void (lastPage.current = path))
  }, [path, qc])
  const openChat = useCallback((o?: { send?: string; newThread?: boolean }) => {
    if (o?.newThread) setThreadId(null)
    if (o?.send) setAutoSend(o.send)
    setOpen(true)
  }, [setThreadId])
  const clearAutoSend = useCallback(() => setAutoSend(null), [])
  return <Ctx.Provider value={{ open, setOpen, threadId, setThreadId, autoSend, clearAutoSend, openChat, pageContext, setPageContext }}>{children}</Ctx.Provider>
}

export const useChat = () => {
  const c = useContext(Ctx)
  if (!c) throw new Error('ChatProvider missing')
  return c
}

/** Tell the chat what the user is looking at, so "draft an email to her" just works. */
export function usePageContext(path: string, label: string | undefined) {
  const { setPageContext } = useChat()
  useEffect(() => {
    setPageContext({ path, ...(label ? { label } : {}) })
    return () => setPageContext(null)
  }, [path, label, setPageContext])
}

// ---------------------------------------------------------------- rendering

const toolLabel = (name: string) => {
  const n = name.replace(/^mcp__sidedoor__/, '')
  const map: Record<string, string> = {
    WebSearch: 'Searched the web',
    WebFetch: 'Read a web page',
    Read: 'Read a file',
    Write: 'Wrote a file',
    Edit: 'Edited a file',
    Glob: 'Looked for files',
    Grep: 'Searched files',
  }
  return map[n] ?? n.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

const toolDetail = (input: unknown) => {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.query ?? o.url ?? o.file_path ?? o.pattern ?? o.name ?? o.title ?? o.summary ?? o.companyName ?? o.id
  return typeof v === 'string' ? v : ''
}

function ToolChip({ part }: { part: Extract<Part, { type: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const pending = part.result === undefined
  return (
    <div className="my-1.5">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn('flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-left text-xs text-muted-foreground hover:bg-muted', part.isError && 'border-destructive/50 text-destructive')}
      >
        {pending ? <Loader2 className="size-3 shrink-0 animate-spin" /> : <Wrench className="size-3 shrink-0" />}
        <span className="shrink-0 font-medium text-foreground/80">{toolLabel(part.name)}</span>
        <span className="truncate">{toolDetail(part.input)}</span>
        <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <pre className="mt-1 max-h-64 overflow-auto rounded-md bg-muted/60 p-2 text-[11px] whitespace-pre-wrap text-muted-foreground">
          {JSON.stringify(part.input, null, 1)}
          {part.result ? `\n\n→ ${part.result}` : ''}
        </pre>
      )}
    </div>
  )
}

function MessageView({ m }: { m: Msg }) {
  if (m.role === 'user') {
    const text = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-primary/15 px-3.5 py-2 text-sm whitespace-pre-wrap">{text}</div>
      </div>
    )
  }
  return (
    <div className="space-y-0.5">
      {m.parts.map((p, i) => (p.type === 'text' ? <Markdown key={i}>{p.text}</Markdown> : <ToolChip key={i} part={p} />))}
    </div>
  )
}

// ---------------------------------------------------------------- voice input

type Recognition = { start: () => void; stop: () => void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onend: (() => void) | null; continuous: boolean; interimResults: boolean; lang: string }
const getRecognition = (): Recognition | null => {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const C = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return C ? new C() : null
}

// ---------------------------------------------------------------- chat view

export function ChatView({ threadId, onThread, className, autoFocus }: { threadId: string | null; onThread: (id: string) => void; className?: string; autoFocus?: boolean }) {
  const qc = useQueryClient()
  const chat = useChat()
  const thread = useQuery({ ...qo.thread(threadId ?? ''), enabled: !!threadId })
  const [input, setInput] = useState('')
  const [live, setLive] = useState<Msg | null>(null)
  const [pendingUser, setPendingUser] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [listening, setListening] = useState(false)
  const recRef = useRef<Recognition | null>(null)
  const esRef = useRef<EventSource | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const persisted: Msg[] = (thread.data?.messages ?? []).map((m) => ({ id: m.id, role: m.role, parts: m.parts as Part[] }))

  const listen: (id: string, attempt?: number) => void = useCallback(
    (id: string, attempt = 0) => {
      esRef.current?.close()
      const es = new EventSource(`/api/chat/${id}`)
      esRef.current = es
      const msg: Msg = { id: 'live', role: 'assistant', parts: [] }
      es.onmessage = (ev) => {
        const e = JSON.parse(ev.data) as { type: string; delta?: string; id?: string; name?: string; input?: unknown; result?: string; isError?: boolean; message?: string }
        if (e.type === 'idle') {
          es.close()
          setBusy(false)
          // Nothing in flight: whatever finished while we were away is in the saved thread.
          void qc.fetchQuery({ ...qo.thread(id), staleTime: 0 }).finally(() => setLive(null))
          return
        }
        setBusy(true)
        if (e.type === 'text' && e.delta) {
          const last = msg.parts[msg.parts.length - 1]
          if (last?.type === 'text') last.text += e.delta
          else msg.parts.push({ type: 'text', text: e.delta })
        } else if (e.type === 'tool' && e.name) {
          msg.parts.push({ type: 'tool', ...(e.id ? { id: e.id } : {}), name: e.name, input: e.input })
        } else if (e.type === 'tool_result') {
          const t = msg.parts.find((p) => p.type === 'tool' && p.id === e.id)
          if (t?.type === 'tool') {
            t.result = e.result ?? ''
            t.isError = e.isError ?? false
          }
        } else if (e.type === 'error') {
          setError(e.message ?? 'Something went wrong')
        } else if (e.type === 'done') {
          es.close()
          // Swap the live copy for the saved one only once it has loaded, then refresh the page's data.
          void qc
            .fetchQuery({ ...qo.thread(id), staleTime: 0 })
            .finally(() => {
              setLive(null)
              setBusy(false)
            })
            .then(() => qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'thread' }))
          return
        }
        setLive({ ...msg, parts: [...msg.parts] })
      }
      es.onerror = () => {
        es.close()
        if (esRef.current !== es) return
        // Dropped mid-answer (sleep, network, proxy): reconnect — the server replays the turn from the start.
        if (attempt < 5) {
          setTimeout(() => esRef.current === es && listen(id, attempt + 1), 1000 * 2 ** attempt)
          return
        }
        setBusy(false)
        void qc.fetchQuery({ ...qo.thread(id), staleTime: 0 }).finally(() => setLive(null))
      }
    },
    [qc],
  )

  // Reattach to an in-flight turn (e.g. after the phone slept).
  useEffect(() => {
    if (threadId) listen(threadId)
    return () => esRef.current?.close()
  }, [threadId, listen])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [persisted.length, live, pendingUser])

  const send = async (text: string) => {
    const message = text.trim()
    if (!message || busy) return
    setError(null)
    setInput('')
    setPendingUser(message)
    setBusy(true)
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: threadId ?? undefined, message, pageContext: chat.pageContext?.path, pageLabel: chat.pageContext?.label }),
    })
    const data = (await res.json()) as { threadId?: string; error?: string }
    if (!res.ok || !data.threadId) {
      setError(data.error ?? 'Failed to send')
      setBusy(false)
      setPendingUser(null)
      setInput(message)
      return
    }
    // The server stored the user message before replying, so the refetched thread includes it.
    await qc.fetchQuery({ ...qo.thread(data.threadId), staleTime: 0 })
    setPendingUser(null)
    if (data.threadId !== threadId) onThread(data.threadId)
    else listen(data.threadId)
    void qc.invalidateQueries({ queryKey: ['threads'] })
  }

  const { autoSend, clearAutoSend } = chat
  useEffect(() => {
    if (!autoSend || busy) return
    clearAutoSend()
    void send(autoSend)
  }, [autoSend])

  const toggleMic = () => {
    if (listening) {
      recRef.current?.stop()
      return
    }
    const rec = getRecognition()
    if (!rec) {
      setError('Voice input isn’t supported in this browser. Use your keyboard’s dictation button.')
      return
    }
    const base = input ? `${input.trimEnd()} ` : ''
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'
    rec.onresult = (e) => setInput(base + Array.from(e.results, (r) => r[0]?.transcript ?? '').join(''))
    rec.onend = () => setListening(false)
    recRef.current = rec
    rec.start()
    setListening(true)
  }

  const stop = () => {
    if (threadId) void fetch(`/api/chat/${threadId}`, { method: 'DELETE' })
  }

  const empty = persisted.length === 0 && !live && !pendingUser
  const storyMode = thread.data?.thread.context?.mode === 'story'

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {storyMode && (
        <div className="border-b bg-primary/10 px-4 py-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">Story interview.</span> Answer in your own words (the mic works). Say “done” when you’re finished; your AI shows the entry before saving it to your <Link to="/stories" className="text-primary">story bank</Link>.
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {empty ? (
          <Starters page={chat.pageContext} onPick={(t) => void send(t)} />
        ) : (
          <div className="space-y-4">
            {persisted.map((m) => (
              <MessageView key={m.id} m={m} />
            ))}
            {pendingUser && (
              <MessageView m={{ id: 'pending', role: 'user', parts: [{ type: 'text', text: pendingUser }] }} />
            )}
            {live && <MessageView m={live} />}
            {busy && !live?.parts.length && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Thinking…
              </div>
            )}
          </div>
        )}
        {error && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}
        <div ref={bottomRef} />
      </div>
      <div className="border-t bg-background/80 p-3 backdrop-blur pb-safe">
        <div className="flex items-end gap-2 rounded-2xl border bg-card p-1.5 focus-within:border-primary/60">
          <Textarea
            ref={taRef}
            autoFocus={autoFocus}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send(input)
              }
            }}
            rows={1}
            placeholder={listening ? 'Listening…' : 'Message your AI…'}
            className="max-h-40 min-h-9 resize-none border-0 bg-transparent px-2 py-1.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
          <Button type="button" size="icon" variant={listening ? 'default' : 'ghost'} className="shrink-0 rounded-full" onClick={toggleMic} aria-label="Voice input">
            <Mic />
          </Button>
          {busy ? (
            <Button type="button" size="icon" variant="secondary" className="shrink-0 rounded-full" onClick={stop} aria-label="Stop">
              <Square className="fill-current" />
            </Button>
          ) : (
            <Button type="button" size="icon" className="shrink-0 rounded-full" disabled={!input.trim()} onClick={() => void send(input)} aria-label="Send">
              <ArrowUp />
            </Button>
          )}
        </div>
        {threadId && (
          <div className="mt-1.5 px-1 text-[11px] text-muted-foreground">
            <Link to="/chat/$threadId" params={{ threadId }} className="hover:text-foreground">
              Open full thread
            </Link>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- thread picker

/** Panel header: the current chat's title; opens a list with this page's chats first. */
export function ThreadPicker({ className }: { className?: string }) {
  const chat = useChat()
  const page = chat.pageContext?.path ?? null
  const [open, setOpen] = useState(false)
  const list = useQuery({ ...qo.panelThreads(page), enabled: open || !!chat.threadId })
  const current = useQuery({ ...qo.thread(chat.threadId ?? ''), enabled: !!chat.threadId })
  const title = chat.threadId ? (current.data?.thread.title ?? 'Chat') : 'New chat'
  const row = (t: { id: string; title: string; updatedAt: string }) => (
    <DropdownMenuItem key={t.id} onSelect={() => chat.setThreadId(t.id)} className={cn('flex items-baseline gap-2', t.id === chat.threadId && 'bg-accent/60')}>
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        <TimeAgo iso={t.updatedAt} />
      </span>
    </DropdownMenuItem>
  )
  const here = list.data?.here ?? []
  const recent = list.data?.recent ?? []
  const pageName = page?.startsWith('/applications/') ? 'this application' : page?.startsWith('/jobs/') ? 'this job' : page?.startsWith('/people/') ? 'this person' : 'this page'
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button type="button" className={cn('flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm font-semibold hover:bg-muted', className)}>
          <span className="truncate">{title}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-[70vh] w-[340px] overflow-y-auto">
        <DropdownMenuItem onSelect={() => chat.setThreadId(null)}>
          <Plus /> New chat
        </DropdownMenuItem>
        {here.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">About {pageName}</DropdownMenuLabel>
            {here.map(row)}
          </>
        )}
        {recent.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Recent</DropdownMenuLabel>
            {recent.map(row)}
          </>
        )}
        {list.isLoading && <div className="px-2 py-1.5 text-xs text-muted-foreground">Loading…</div>}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/chat">All chats</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Something to start from, for the page you're on. */
const STARTERS: Array<[RegExp, string[]]> = [
  [/^\/applications\//, ['Is this worth my time? Be blunt.', 'Who should I reach out to here, and what should I say?', 'Draft a follow-up for this application.']],
  [/^\/jobs\//, ['How well do I fit this, and what’s my biggest gap?', 'Find the hiring manager for this role.', 'What does this company actually do?']],
  [/^\/people\//, ['Draft a short follow-up to them.', 'What do we have in common?', 'Log that I emailed them today.']],
  [/^\/resume/, ['Tighten my summary.', 'Which bullets are weakest, and why?', 'What’s missing for the roles I want?']],
  [/.*/, ['What should I focus on today?', 'What’s stuck in my pipeline?', 'Find five new companies hiring for what I want.']],
]

function Starters({ page, onPick }: { page: { path: string; label?: string } | null; onPick: (t: string) => void }) {
  const { data } = useQuery(qo.aiStatus())
  const ai = data?.providers.find((p) => p.id === data.default)
  const list = STARTERS.find(([re]) => re.test(page?.path ?? '/'))?.[1] ?? []
  return (
    <div className="flex h-full flex-col justify-end gap-3 pb-2">
      <div className="text-xs text-muted-foreground">
        {ai ? `${ai.name} answers here` : 'Connect an AI in Settings to chat'}
        {page?.label && (
          <>
            {' '}
            and can see you’re on <span className="text-foreground">{page.label}</span>
          </>
        )}
        .
      </div>
      {ai && (
        <div className="flex flex-col items-start gap-1.5">
          {list.map((t) => (
            <button key={t} type="button" onClick={() => onPick(t)} className="rounded-lg border px-3 py-1.5 text-left text-sm transition-colors hover:border-foreground/30 hover:bg-accent/40">
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

