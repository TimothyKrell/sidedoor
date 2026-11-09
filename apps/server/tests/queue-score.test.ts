import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { queueParts, queueScore } from '@sidedoor/shared/queue-score'
import { db, schema } from '../src/db/client'
import { newId, nowIso } from '../src/ids'
import { prepPriority, refreshPrepOrder } from '../src/jobs/tasks'
import { createApplication } from '../src/services/applications'
import { enqueueTask } from '../src/services/tasks'

const now = Date.parse('2026-11-09T12:00:00Z')
const daysAgo = (d: number) => new Date(now - d * 86400_000).toISOString()
const o = { salaryMin: 200_000, now }

test('newness counts most: a fresh good job beats a stale great one', () => {
  const fresh = queueScore({ postedAt: daysAgo(1), fitScore: 78, compMax: 240_000 }, o)
  const stale = queueScore({ postedAt: daysAgo(30), fitScore: 90, compMax: 300_000 }, o)
  expect(fresh).toBeGreaterThan(stale)
})

test('fit and pay weigh the same', () => {
  const base = { postedAt: daysAgo(3) }
  // Ten fit points and the matching pay step move the score alike.
  const moreFit = queueScore({ ...base, fitScore: 85, compMax: 250_000 }, o)
  const morePay = queueScore({ ...base, fitScore: 75, compMax: 287_500 }, o)
  expect(Math.abs(moreFit - morePay)).toBeLessThanOrEqual(1)
})

test('each part is 0-100, and a missing one is middling-low rather than zero', () => {
  expect(queueParts({ postedAt: daysAgo(0), fitScore: 95, compMax: 300_000 }, o)).toMatchObject({ fresh: 100, fit: 100, pay: 100 })
  expect(queueParts({ postedAt: daysAgo(4) }, o).fresh).toBe(50)
  expect(queueParts({}, o)).toMatchObject({ fresh: 25, fit: 30, pay: 40, ageDays: null })
  expect(queueParts({ compMax: 140_000 }, o).pay).toBe(0)
  expect(queueScore({ postedAt: daysAgo(1), fitScore: 80 }, o)).toBeGreaterThan(queueScore({ postedAt: daysAgo(1), fitScore: 80, compMax: 150_000 }, o))
})

test('background prep runs in work-on-first order, and stays under what the user asks for', () => {
  expect(prepPriority(100)).toBe(9)
  expect(prepPriority(42)).toBe(4)
  const job = (postedAt: string, fit: number) => {
    const id = newId('job_')
    db.insert(schema.postings).values({ id, key: `ashby:q:${id}`, title: 'Engineering Manager', postedAt, compMax: 260_000, firstSeenAt: nowIso(), lastSeenAt: nowIso(), triageStatus: 'done', fitScore: fit }).run()
    return createApplication({ companyName: `Queueco ${id}`, role: 'Engineering Manager', stage: 'interested', status: 'potential', postingId: id, fitScore: fit }).id
  }
  const fresh = job(new Date(Date.now() - 86400_000).toISOString(), 76)
  const stale = job(new Date(Date.now() - 40 * 86400_000).toISOString(), 88)
  const tFresh = enqueueTask('prep', 'Prep fresh', { applicationId: fresh })
  const tStale = enqueueTask('prep', 'Prep stale', { applicationId: stale })
  const asked = enqueueTask('prep', 'Prep asked', { applicationId: stale, priority: 10, dedupe: false })
  refreshPrepOrder()
  const pr = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!.priority
  expect(pr(tFresh.id)).toBeGreaterThan(pr(tStale.id))
  expect(pr(tFresh.id)).toBeLessThan(10)
  expect(pr(asked.id)).toBe(10)
})
