import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { claimNextTask } from '../src/jobs/tasks'
import { enqueueTask } from '../src/services/tasks'

const later = () => new Date(Date.now() + 3600_000).toISOString()

test('asking for held background work again runs it now; background asks leave the hold alone', () => {
  const t = enqueueTask('discover', 'Find companies')
  db.update(schema.tasks).set({ runAfter: later() }).where(eq(schema.tasks.id, t.id)).run()

  // Background asking again changes nothing.
  enqueueTask('discover', 'Find companies')
  expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.runAfter).not.toBeNull()

  // The user asking clears the hold and moves it up.
  const again = enqueueTask('discover', 'Find companies', { priority: 10 })
  expect(again.id).toBe(t.id)
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!
  expect(row.runAfter).toBeNull()
  expect(row.priority).toBe(10)

  // Already at the user's priority but held (deferred before it was bumped): asking again still lifts it.
  db.update(schema.tasks).set({ runAfter: later() }).where(eq(schema.tasks.id, t.id)).run()
  enqueueTask('discover', 'Find companies', { priority: 10 })
  expect(db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!.runAfter).toBeNull()
  expect(claimNextTask()?.id).toBe(t.id)
})
