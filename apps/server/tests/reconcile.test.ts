import { eq } from 'drizzle-orm'
import { expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { newId, nowIso } from '../src/ids'
import { reconcile } from '../src/jobs/runner'
import { listApplications } from '../src/queries'
import { createApplication, getApplication, requestChanges } from '../src/services/applications'
import { enqueueTask } from '../src/services/tasks'

const posting = (closed: boolean) => {
  const id = newId('job_')
  db.insert(schema.postings).values({ id, key: id, title: 'Engineer', firstSeenAt: nowIso(), lastSeenAt: nowIso(), closedAt: closed ? nowIso() : null }).run()
  return id
}

test('prep work shows on the application without changing its stage, first prep and revisions alike', () => {
  const fresh = createApplication({ companyName: 'Initech', role: 'Engineer', stage: 'interested', status: 'potential' })
  const revised = createApplication({ companyName: 'Hooli', role: 'Engineer', stage: 'review', status: 'potential', packageMd: '# Hooli' })
  enqueueTask('prep', 'Prepare: Initech', { applicationId: fresh.id })
  requestChanges(revised.id, 'Shorter summary')
  const open = listApplications().open
  expect(open.find((a) => a.id === fresh.id)).toMatchObject({ stage: 'interested', prep: { revision: false, running: false } })
  expect(open.find((a) => a.id === revised.id)).toMatchObject({ stage: 'review', prep: { revision: true, running: false } })
  db.update(schema.tasks).set({ status: 'done' }).where(eq(schema.tasks.applicationId, fresh.id)).run()
  expect(listApplications().open.find((a) => a.id === fresh.id)?.prep).toBeNull()
})

test('a listing that closes while its application is being prepared flags it instead of closing it', () => {
  const busy = createApplication({ companyName: 'Globex', role: 'Engineer', stage: 'interested', status: 'potential', postingId: posting(true) })
  enqueueTask('prep', 'Prepare: Globex', { applicationId: busy.id })
  reconcile()
  expect(getApplication(busy.id)?.stage).toBe('interested')
})

test('when a listing closes, untouched applications close, prepared ones are flagged, sent ones stay', () => {
  const unsent = createApplication({ companyName: 'Acme', role: 'Engineer', stage: 'interested', status: 'potential', postingId: posting(true) })
  const prepared = createApplication({ companyName: 'Acme', role: 'Designer', stage: 'review', status: 'potential', postingId: posting(true) })
  const sent = createApplication({ companyName: 'Acme', role: 'Staff Engineer', stage: 'applied', status: 'active', postingId: posting(true) })
  const open = createApplication({ companyName: 'Acme', role: 'Lead', stage: 'interested', status: 'potential', postingId: posting(false) })
  reconcile()
  expect(getApplication(unsent.id)).toMatchObject({ stage: 'closed', closedReason: 'Listing closed' })
  expect(getApplication(prepared.id)?.stage).toBe('review')
  expect(getApplication(sent.id)?.stage).toBe('applied')
  expect(getApplication(open.id)?.stage).toBe('interested')
})
