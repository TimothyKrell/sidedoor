import { type QueryClient, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'

/**
 * Which cached queries (by the first element of their key) show data from each table.
 * When the server reports a table changed, every open page refetches what depends on it.
 * Chat threads are left out: an in-flight answer has its own stream (see ChatView).
 */
const DEPENDENTS: Record<string, string[]> = {
  companies: ['applications', 'application', 'postings', 'posting', 'people', 'person', 'radar', 'today', 'sources'],
  sources: ['sources', 'radar', 'posting'],
  postings: ['postings', 'posting', 'today', 'radar', 'application'],
  applications: ['applications', 'application', 'today', 'person', 'posting', 'search'],
  people: ['people', 'person', 'application', 'today', 'search'],
  application_people: ['application', 'person'],
  interactions: ['person', 'application', 'today', 'people'],
  drafts: ['person', 'application', 'today', 'people'],
  research: ['application', 'posting', 'radar'],
  tasks: ['tasks', 'application', 'applications', 'status', 'today', 'grokBot'],
  activity: ['today'],
  notifications: [],
  chat_threads: ['threads'],
  chat_messages: ['threads'],
  settings: ['settings', 'aiStatus', 'docs', 'grokBot'],
  documents: ['docs', 'doc', 'stories'],
  resumes: ['resumes', 'resume', 'application'],
}

const NEVER = new Set(['thread'])

export const invalidateFor = (qc: QueryClient, tables: string[] | 'all') => {
  const keys = tables === 'all' ? null : new Set(tables.flatMap((t) => DEPENDENTS[t] ?? []))
  if (keys?.size === 0) return
  return qc.invalidateQueries({
    predicate: (q) => {
      const head = String(q.queryKey[0])
      return !NEVER.has(head) && (keys === null || keys.has(head))
    },
  })
}

type ServerEvent = { type: 'changes'; tables: string[] } | { type: 'notice'; title: string; body: string; path?: string; kind: string } | { type: 'ai-status' }

const noticeListeners = new Set<(n: Extract<ServerEvent, { type: 'notice' }>) => void>()
/** Notifications as they happen (the shell shows them as toasts in the browser). */
export const onNotice = (fn: (n: Extract<ServerEvent, { type: 'notice' }>) => void) => {
  noticeListeners.add(fn)
  return () => noticeListeners.delete(fn)
}

/** Keep every open page current with changes made anywhere: other tabs, the phone, agents, background jobs. */
export function useLiveUpdates() {
  const qc = useQueryClient()
  useEffect(() => {
    const es = new EventSource('/api/events')
    let pending = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | null = null
    let dropped = false
    es.onmessage = (ev) => {
      const e = JSON.parse(ev.data) as ServerEvent
      if (e.type === 'notice') {
        for (const l of noticeListeners) l(e)
        return
      }
      if (e.type === 'ai-status') {
        void qc.invalidateQueries({ queryKey: ['aiStatus'] })
        return
      }
      for (const t of e.tables) pending.add(t)
      // Batch bursts (a scout run touches hundreds of rows) into one refetch.
      timer ??= setTimeout(() => {
        const batch = [...pending]
        pending = new Set()
        timer = null
        void invalidateFor(qc, batch)
      }, 250)
    }
    es.onerror = () => {
      // EventSource reconnects by itself; anything could have changed while we were away.
      dropped = true
    }
    es.onopen = () => {
      if (dropped) void invalidateFor(qc, 'all')
      dropped = false
    }
    return () => {
      es.close()
      if (timer) clearTimeout(timer)
    }
  }, [qc])
}
