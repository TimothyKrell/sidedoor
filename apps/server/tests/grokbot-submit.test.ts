import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'

// The AI's answers, in order: the fill, then (when it submits) the submit step.
const ai = vi.hoisted(() => ({ replies: [] as unknown[], prompts: [] as string[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    return { text: '', data: ai.replies.shift(), log: ['step'], sessionId: 'sess_1', costUsd: 0.01, provider: 'claude', model: 'm' }
  },
}))
const tab = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../src/browser', async (orig) => ({
  ...(await orig<typeof import('../src/browser')>()),
  openFormTab: async () => ({
    cdpEndpoint: 'ws://x',
    finish: async (message?: string) => void tab.calls.push(message ? `finish: ${message}` : 'finish'),
    unguard: async () => void tab.calls.push('unguard'),
    close: async () => void tab.calls.push('close'),
  }),
}))
vi.mock('../src/mcp/playwright', () => ({ withBrowserTools: (_e: string, _d: string, fn: () => Promise<unknown>) => fn() }))
const pdf = join(mkdtempSync(join(tmpdir(), 'sd-pdf-')), 'Resume.pdf')
writeFileSync(pdf, '%PDF')
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), resumeForApplication: () => ({ id: 'res_x', pdfFile: null }), buildResumePdf: async () => ({ path: pdf }) }))
const SNAP = '### Page\n- Page URL: https://jobs.example.com/thanks\n- Page Title: Application received\n### Snapshot\n```yaml\n- heading "Thank you for applying!" [level=1] [ref=e2]\n- paragraph [ref=e3]:\n  - text: We will be in touch.\n```'
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => SNAP }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { submissions } = await import('../src/jobs/fill-form')
const { browserArgsProblem } = await import('../src/mcp/server')
const { toolsFor } = await import('../src/mcp/tools')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication, requestSubmit, updateApplication } = await import('../src/services/applications')
const { answerFormQuestions, answerQuestions, listQuestions } = await import('../src/services/questions')
const { docBody } = await import('../src/services/documents')
const { enqueueTask } = await import('../src/services/tasks')
const { updateSettings } = await import('../src/settings')

const allow = (submit = true) => {
  grokBotToken(true)
  updateSettings('grokBot', { submit })
}
const app = (companyName: string, o: Partial<typeof schema.applications.$inferInsert> = {}) =>
  createApplication({ companyName, role: 'Engineering Manager', stage: 'review', applyUrl: `https://jobs.example.com/${companyName}`, packageMd: '# Package\n\n### Q1 Why us?\nBecause.', ...o })
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const run = async (id: string) => {
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, id)).run()
  await executeTask({ ...task(id), status: 'running' })
  return task(id)
}
const filled = { outcome: 'ready', summary: 'All filled.', filled: [], needsYou: [] }

afterEach(() => {
  setSecret('grokbot-token', '')
  updateSettings('grokBot', { submit: false })
  db.delete(schema.tasks).run()
  ai.replies = []
  ai.prompts = []
  tab.calls = []
})

describe('letting Grok Bot submit', () => {
  test('only Grok Bot sees the submit tools, and only while the user allows it', () => {
    const names = (p: 'app' | 'grokbot') => toolsFor(p).map((t) => t.name)
    grokBotToken(true)
    expect(names('grokbot')).not.toContain('submit_application')
    allow()
    expect(names('grokbot')).toEqual(expect.arrayContaining(['submit_application', 'submission_status', 'answer_questions']))
    expect(names('app')).not.toContain('submit_application')
  })

  test('asking to submit approves the application and queues the fill that submits it', () => {
    allow()
    const a = app('Acme')
    const t = requestSubmit(a.id)
    expect(getApplication(a.id)!.stage).toBe('approved')
    expect(t.kind).toBe('submit-assist')
    expect(t.input).toMatchObject({ submit: true, by: 'grokbot' })
    // Asking again doesn't queue a second one.
    expect(requestSubmit(a.id).id).toBe(t.id)
  })

  test('a fill already waiting for the user becomes the one that submits', () => {
    const a = app('Initech', { stage: 'approved' })
    const waiting = enqueueTask('submit-assist', 'Fill form: Initech', { applicationId: a.id })
    expect(requestSubmit(a.id).id).toBe(waiting.id)
    expect(task(waiting.id).input.submit).toBe(true)
  })

  test('nothing is submitted twice, or without a package or a form', () => {
    expect(() => requestSubmit(app('Done', { stage: 'applied', appliedAt: '2026-10-01T00:00:00Z' }).id)).toThrow(/nothing to submit/)
    expect(() => requestSubmit(app('NoPkg', { packageMd: null }).id)).toThrow(/package/)
    expect(() => requestSubmit(app('Mail', { applyUrl: 'mailto:jobs@mail.example' }).id)).toThrow(/email/)
  })

  test('submit clicks are refused unless the submit step allows them', () => {
    expect(browserArgsProblem('browser_type', { target: 'e5', text: 'hi', submit: true }, '/x')).not.toBeNull()
    expect(browserArgsProblem('browser_type', { target: 'e5', text: 'hi', submit: true }, '/x', true)).toBeNull()
  })
})

describe('the fill that submits', () => {
  test('a fill with nothing left unanswered is submitted, and the application moves to Applied', async () => {
    allow()
    const a = app('Globex')
    const t = requestSubmit(a.id)
    ai.replies = [filled, { outcome: 'submitted', summary: 'Confirmation: thanks for applying.', problems: [], confirmation: 'Thank you for applying!' }]
    expect((await run(t.id)).status).toBe('done')
    expect(tab.calls).toEqual(['unguard', 'close'])
    expect(ai.prompts[0]).toContain('This one gets submitted')
    const after = getApplication(a.id)!
    expect(after.stage).toBe('applied')
    expect(after.appliedAt).toBeTruthy()
    expect(submissions(a.id)[0]).toMatchObject({
      status: 'submitted',
      summary: 'Confirmation: thanks for applying.',
      evidence: { url: 'https://jobs.example.com/thanks', title: 'Application received', page: 'Thank you for applying! · We will be in touch.', reported: 'Thank you for applying!' },
    })
  })

  test('a dry run fills and reports, and never submits or approves', async () => {
    allow()
    const a = app('Cyberdyne')
    const t = requestSubmit(a.id, { dryRun: true })
    expect(getApplication(a.id)!.stage).toBe('review')
    ai.replies = [filled]
    await run(t.id)
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('This one gets submitted')
    expect(tab.calls).toEqual(['finish'])
    expect(getApplication(a.id)!.stage).toBe('review')
    expect(submissions(a.id)[0]).toMatchObject({ status: 'ready', dryRun: true })
    // Sending it for real afterwards is a real submit.
    const real = requestSubmit(a.id)
    expect(real.input).toMatchObject({ submit: true, dryRun: false })
  })

  test("answers to a dry run's questions are tried as a dry run again", async () => {
    allow()
    const a = app('Tyrell')
    const t = requestSubmit(a.id, { dryRun: true })
    ai.replies = [{ outcome: 'needs_you', summary: 'One question.', filled: [], needsYou: [{ field: 'Start date', why: 'not in the package' }] }]
    await run(t.id)
    expect(tab.calls).toEqual(['finish: Sidedoor stopped before submitting: 1 question for you. Answer it in Sidedoor and it fills and submits this again, or finish this form yourself.'])
    const again = answerFormQuestions(a.id, [{ question: 'Start date', answer: 'Two weeks' }])
    expect(again.input.dryRun).toBe(true)
    expect(getApplication(a.id)!.stage).toBe('review')
  })

  test('questions the package does not answer stop it before submit, and the answers send it again', async () => {
    allow()
    const a = app('Hooli')
    const t = requestSubmit(a.id)
    ai.replies = [{ outcome: 'needs_you', summary: 'Two questions need you.', filled: [], needsYou: [{ field: 'Desired salary', why: 'not in the package' }, { field: 'Do you know anyone here?', why: 'not in the package', options: ['Yes', 'No'] }] }]
    await run(t.id)
    // The window stays open, saying why it stopped.
    expect(tab.calls).toEqual([expect.stringMatching(/^finish: Sidedoor stopped before submitting: 2 questions for you\. Answer them/)])
    expect(ai.prompts).toHaveLength(1)
    expect(getApplication(a.id)!.stage).toBe('approved')
    const s = submissions(a.id)[0]!
    expect(s.status).toBe('questions')
    expect(s.questions).toEqual([
      { question: 'Desired salary', why: 'not in the package', options: [] },
      { question: 'Do you know anyone here?', why: 'not in the package', options: ['Yes', 'No'] },
    ])

    const again = answerFormQuestions(a.id, [
      { question: 'Desired salary', answer: '$200k base', reusable: true },
      { question: 'Do you know anyone here?', answer: 'No' },
    ])
    expect(again.id).not.toBe(t.id)
    expect(again.input.submit).toBe(true)
    const pkg = getApplication(a.id)!.packageMd!
    expect(pkg).toContain('### Q1 Why us?')
    expect(pkg).toContain('## Your answers to questions\n\n### Desired salary\n$200k base')
    expect(docBody('answers')).toContain('**Desired salary** $200k base')
    expect(docBody('answers')).not.toContain('anyone here')
    // Kept as questions: answered, by Grok Bot, the reusable one for every application.
    const kept = listQuestions({ applicationId: a.id, status: 'answered' })
    expect(kept.map((q) => [q.question, q.answer, q.answeredBy, q.scope])).toEqual(
      expect.arrayContaining([
        ['Desired salary', '$200k base', 'grokbot', 'global'],
        ['Do you know anyone here?', 'No', 'grokbot', 'application'],
      ]),
    )
    expect(submissions(a.id)[0]!.status).toBe('queued')
    // Filling it again closes the window it left open, then opens a new one.
    tab.calls = []
    ai.replies = [filled, { outcome: 'submitted', summary: 'In.', problems: [], confirmation: 'Thanks!' }]
    await run(again.id)
    expect(tab.calls).toEqual(['close', 'unguard', 'close'])
  })

  test("the form's questions are kept as questions, and answering the last one in the app sends it again", async () => {
    allow()
    const a = app('Initech')
    const t = requestSubmit(a.id)
    ai.replies = [{ outcome: 'needs_you', summary: 'Two questions.', filled: [], needsYou: [{ field: 'Earliest start date', why: 'not in the package' }, { field: 'Preferred office', why: 'required', options: ['NYC', 'Remote'] }] }]
    await run(t.id)
    const open = listQuestions({ applicationId: a.id, status: 'open' })
    expect(open.map((q) => [q.question, q.askedBy])).toEqual(expect.arrayContaining([['Earliest start date', 'fill'], ['Preferred office', 'fill']]))
    expect(open.find((q) => q.question === 'Preferred office')!.options).toEqual(['NYC', 'Remote'])
    const start = open.find((q) => q.question === 'Earliest start date')!
    expect(answerQuestions([{ id: start.id, answer: 'Two weeks from offer' }], 'you').resubmitted).toEqual([])
    const office = open.find((q) => q.question === 'Preferred office')!
    const r = answerQuestions([{ id: office.id, answer: 'Remote', allApplications: false }], 'you')
    expect(r.resubmitted).toEqual([a.id])
    expect(submissions(a.id)[0]!.status).toBe('queued')
    expect(getApplication(a.id)!.packageMd).toContain('### Preferred office\nRemote')
  })

  test('answers in the app never queue a submit while Grok Bot may not submit', async () => {
    allow()
    const a = app('Massive')
    const t = requestSubmit(a.id)
    ai.replies = [{ outcome: 'needs_you', summary: 'One question.', filled: [], needsYou: [{ field: 'Team preference', why: 'required' }] }]
    await run(t.id)
    updateSettings('grokBot', { submit: false })
    const [q] = listQuestions({ applicationId: a.id, status: 'open' })
    expect(answerQuestions([{ id: q!.id, answer: 'Platform' }], 'you').resubmitted).toEqual([])
    expect(submissions(a.id)[0]!.status).toBe('questions')
  })

  test('with submitting turned off it fills for review and never runs the submit step', async () => {
    allow()
    const a = app('Umbrella')
    const t = requestSubmit(a.id)
    updateSettings('grokBot', { submit: false })
    ai.replies = [filled]
    await run(t.id)
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).not.toContain('This one gets submitted')
    expect(tab.calls).toEqual(['finish'])
    expect(getApplication(a.id)!.stage).toBe('approved')
    expect(submissions(a.id)[0]!.status).toBe('not_submitted')
  })

  test('a submit step that never reported back is not tried again', async () => {
    allow()
    const a = app('Stark')
    const t = requestSubmit(a.id)
    db.update(schema.tasks).set({ input: { ...t.input, submitStartedAt: '2026-10-30T10:00:00Z' } }).where(eq(schema.tasks.id, t.id)).run()
    const done = await run(t.id)
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/never reported back/)
    expect(ai.prompts).toHaveLength(0)
  })

  test('a submit the site rejects leaves the form open and keeps the application unsent', async () => {
    allow()
    const a = app('Wayne')
    updateApplication(a.id, { stage: 'approved' })
    const t = requestSubmit(a.id)
    ai.replies = [filled, { outcome: 'not_submitted', summary: 'Phone number was rejected.', problems: [{ field: 'Phone', why: 'Use the format +1 555 555 5555' }] }]
    const done = await run(t.id)
    expect(tab.calls).toEqual(['unguard', expect.stringMatching(/^finish: Sidedoor stopped before submitting: 1 question/)])
    expect(done.input.submitStartedAt).toBeUndefined()
    expect(getApplication(a.id)!.stage).toBe('approved')
    expect(submissions(a.id)[0]).toMatchObject({ status: 'questions', questions: [{ question: 'Phone', why: 'Use the format +1 555 555 5555', options: [] }] })
  })
})
