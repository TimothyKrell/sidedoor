import { eq } from 'drizzle-orm'
import { expect, test, vi } from 'vitest'

const ai = vi.hoisted(() => ({ data: { summary: '', stopped: false as boolean | null } }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async () => ({ text: '', data: ai.data, log: ['read the listing'], sessionId: 'sess_1', costUsd: 0.01, provider: 'claude', model: 'm' }),
}))
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), buildResumePdf: async () => ({ pages: 1 }), tailoredFor: () => ({ id: 'res_x' }) }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { createApplication, getApplication, updateApplication } = await import('../src/services/applications')
const { enqueueTask } = await import('../src/services/tasks')

const run = async (company: string) => {
  const app = createApplication({ companyName: company, role: 'Engineering Manager', stage: 'review' })
  updateApplication(app.id, { packageMd: '# Existing package', nextAction: 'Review the package' })
  const t = enqueueTask('prep', `Prep: ${company}`, { applicationId: app.id, priority: 10, dedupe: false })
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
  await executeTask({ ...t, status: 'running', attempts: 1 })
  return { app: getApplication(app.id)!, task: db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()! }
}

test('a prep told to stop (listing too new) finishes with what the AI said and leaves the application alone', async () => {
  ai.data = { summary: 'TOO NEW: posted 2026-10-05', stopped: true }
  const { app, task } = await run('Globex')
  expect(task.status).toBe('done')
  expect(task.output).toBe('TOO NEW: posted 2026-10-05')
  expect(task.sessionId).toBe('sess_1')
  expect(app.nextAction).toBe('Review the package')
  expect(app.packageMd).toBe('# Existing package')
})

test('a prep that saves nothing without saying it stopped still fails, and keeps what the AI said', async () => {
  ai.data = { summary: 'I looked around', stopped: null }
  const { app, task } = await run('Hooli')
  expect(task.status).toBe('failed')
  expect(task.error).toContain('did not save the application package')
  expect(task.error).toContain('I looked around')
  expect(task.log).toContain('read the listing')
  expect(app.nextAction).toMatch(/^Preparing failed/)
})
