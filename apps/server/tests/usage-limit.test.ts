import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { aiLimitedUntil, usageLimitUntil } from '../src/ai/limits'
import { db, schema } from '../src/db/client'
import { claimNextTask, executeTask, RUNNERS } from '../src/jobs/tasks'
import { setMeta } from '../src/settings'
import { enqueueTask } from '../src/services/tasks'

const CLAUDE = "Claude Code returned an error result: You've hit your session limit · resets 10:10pm (America/New_York)"

test('a usage-limit message gives the reset time in its own time zone; other errors are not limits', () => {
  // 9:40pm in New York (EDT, UTC-4) is 01:40 UTC.
  const at = usageLimitUntil(CLAUDE, new Date('2026-10-29T01:40:00Z'))
  expect(at?.toISOString()).toBe('2026-10-29T02:11:00.000Z')
  // Past the reset time: the next one is tomorrow's.
  expect(usageLimitUntil(CLAUDE, new Date('2026-10-29T03:00:00Z'))?.toISOString()).toBe('2026-10-30T02:11:00.000Z')
  // No time given: try again in half an hour.
  expect(usageLimitUntil('You have hit your usage limit', new Date('2026-10-29T03:00:00Z'))?.toISOString()).toBe('2026-10-29T03:30:00.000Z')
  expect(usageLimitUntil('application missing')).toBeNull()
})

test('a task that hits the usage limit waits for the reset instead of failing, and the queue pauses', async () => {
  const saved = RUNNERS.custom
  RUNNERS.custom = async () => {
    throw new Error(CLAUDE)
  }
  try {
    const t = enqueueTask('custom', 'Raise resume match', { input: { instructions: 'x' }, dedupe: false })
    const claimed = { ...t, status: 'running' as const, attempts: 1 }
    db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
    await executeTask(claimed)
    const after = db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!
    expect(after.status).toBe('queued')
    expect(after.attempts).toBe(0)
    expect(after.error).toBeNull()
    expect(new Date(after.runAfter!).getTime()).toBeGreaterThan(Date.now())
    expect(aiLimitedUntil()).toBe(after.runAfter)
  } finally {
    RUNNERS.custom = saved
    setMeta('aiLimitedUntil', null)
  }
})

test('filling a form goes ahead of the backlog, and is the only work a paused queue takes', () => {
  const backlog = enqueueTask('research', 'Research: Acme', { priority: 10, dedupe: false })
  const fill = enqueueTask('submit-assist', 'Fill form: Acme', { dedupe: false })
  expect(claimNextTask({ interactiveOnly: true })?.id).toBe(fill.id)
  expect(claimNextTask({ interactiveOnly: true })).toBeNull()
  expect(claimNextTask()?.id).toBe(backlog.id)
})
