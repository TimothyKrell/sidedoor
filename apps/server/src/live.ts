import { db } from './db/client'
import { publish } from './events'

/**
 * Tells open pages which tables changed, whoever changed them (a request, a job, an agent over
 * MCP). Triggers bump `change_counters` on every write (migration 0001_live_changes); this polls
 * that tiny table and publishes the changed table names.
 */

const seen = new Map<string, number>()
let timer: ReturnType<typeof setInterval> | null = null

const tick = () => {
  const rows = db.$client.prepare('select tbl, seq from change_counters').all() as { tbl: string; seq: number }[]
  const changed: string[] = []
  for (const { tbl, seq } of rows) {
    const prev = seen.get(tbl)
    if (prev !== undefined && prev !== seq) changed.push(tbl)
    seen.set(tbl, seq)
  }
  if (changed.length) publish({ type: 'changes', tables: changed })
}

export const startLiveChanges = () => {
  if (timer) return
  tick()
  timer = setInterval(() => {
    try {
      tick()
    } catch (e) {
      console.error('[live] poll failed', e)
    }
  }, 400)
  timer.unref()
}
