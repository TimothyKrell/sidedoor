/**
 * In-process event bus feeding `/api/events` (SSE): table changes so pages refetch, notifications
 * for the in-app toast and the browser Notification API, and AI connection status.
 */
export type ServerEvent =
  | { type: 'changes'; tables: string[] }
  | { type: 'notice'; title: string; body: string; path?: string; kind: string }
  | { type: 'ai-status' }

type Listener = (e: ServerEvent) => void
const g = globalThis as unknown as { __sidedoorBus?: Set<Listener> }
const listeners: Set<Listener> = (g.__sidedoorBus ??= new Set())

export const publish = (e: ServerEvent) => {
  for (const l of listeners) {
    try {
      l(e)
    } catch (err) {
      console.error('[events] listener failed', err)
    }
  }
}

export const subscribe = (l: Listener) => {
  listeners.add(l)
  return () => listeners.delete(l)
}
