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
    return { text: '', data: ai.replies.shift(), log: [], sessionId: 'sess_1', costUsd: 0, provider: 'claude', model: 'm' }
  },
}))
vi.mock('../src/browser', async (orig) => ({
  ...(await orig<typeof import('../src/browser')>()),
  openFormTab: async () => ({ cdpEndpoint: 'ws://x', finish: async () => {}, unguard: async () => {}, close: async () => {} }),
}))
vi.mock('../src/mcp/playwright', () => ({ withBrowserTools: (_e: string, _d: string, fn: () => Promise<unknown>) => fn() }))
const pdf = join(mkdtempSync(join(tmpdir(), 'sd-pdf-')), 'Resume.pdf')
writeFileSync(pdf, '%PDF')
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), resumeForApplication: () => ({ id: 'res_x', pdfFile: null }), buildResumePdf: async () => ({ path: pdf }) }))
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => '- Page URL: https://jobs.example.com/thanks' }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { submissions } = await import('../src/jobs/fill-form')
const { checkFill, readPackage, submitRefusal } = await import('../src/form-answers')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication, requestSubmit } = await import('../src/services/applications')
const { docBody, setDoc } = await import('../src/services/documents')
const { answerFormQuestions } = await import('../src/services/questions')
const { updateSettings } = await import('../src/settings')

// Shaped like the package behind the Acmepay dry run on 2026-10-30 (personal details replaced).
const ACMEPAY = `# Review: Acmepay - Senior Staff Software Engineer, Fullstack

## Questions for Sam
1. The form requires pronouns. Should it say "He/him/his"? (yes/no)
2. Have you built search, discovery, or ads features anywhere? One line on where.

## 30-second summary
- **Why apply:** Strong fit on payments and reliability.

## Needs your decision
- [ ] Pronouns (required): suggested "He/him/his", based on your EEO answer. Please confirm.
- [ ] The resume says "Brought time to first byte to ~100 ms". Move it to the right role if needed.
- [ ] "How did you first learn about Acmepay" is set to "Acmepay's Career Site". Change it if another option is truer.
- [x] Salary: none asked.

## Application form
| # | Question | Required | Answer | Source |
|---|---|---|---|---|
| 1 | First Name | Yes | Sam | Answers |
| 5 | Resume/CV | Yes | Tailored resume (upload) | Tailored resume |
| 6 | Cover Letter | No | See Cover letter below | Written for this role |
| 7 | LinkedIn Profile | No | https://www.linkedin.com/in/sam-example/ | Answers |
| 8 | Current Company | No | Example Studios | Experience |
| 11 | Pronouns | Yes | He/him/his (confirm) | Inferred from EEO answer; see Questions |
| 12 | Do you require immigration sponsorship to work for Acmepay in the United States? | Yes | No | Answers |
| 15 | How did you first learn about Acmepay as an employer? | Yes | Acmepay's Career Site | Answers (default; confirm) |
| 20 | Have you previously been employed at Acmepay for any length of time? | Yes | I have not previously been employed at Acmepay | Answers |
| 21 | EEO (gender, race/ethnicity) | No | Male; White | Answers |

## Cover letter
Dear Acmepay hiring team,

I'd like to build for you.

## Submission notes
- ATS: Greenhouse.
`

const STANDARD = `# Standard answers

| Field | Answer | Source |
|---|---|---|
| Phone | 555-0100 | resume |
| Requires visa sponsorship | No | earlier application |
| How did you hear | Company careers page (or the actual source on the lead) | lead source |
| EEO / demographic questions | Gender: Male. Race/ethnicity: White. Veteran and disability status: decline to self-identify | told 2026-10-23 |
`

const PRONOUNS = ['He/him/his', 'She/her/hers', 'They/them/theirs', 'I prefer not to answer']
const HEARD = ["Acmepay's Career Site", 'LinkedIn', 'Referral', 'I have used Acmepay as a product']

// What the filler reported on the Acmepay dry run: every field filled, nothing left to ask.
const acmepayFill = {
  outcome: 'ready',
  summary: 'The Acmepay form is filled and every required field has an answer.',
  filled: [
    { field: 'Resume/CV', value: 'resume.pdf', source: 'resume' },
    { field: 'First Name', value: 'Sam', source: 'standard_answer' },
    { field: 'Cover Letter', value: 'Dear Acmepay hiring team…', source: 'package' },
    { field: 'Current Company', value: 'Example Studios', source: 'package' },
    { field: 'Pronouns', value: 'He/him/his', source: 'package', options: PRONOUNS },
    { field: 'Immigration sponsorship now', value: 'No', source: 'standard_answer', options: ['Yes', 'No'] },
    { field: 'How did you first learn about Acmepay', value: "Acmepay's Career Site", source: 'package', options: HEARD },
    { field: 'Previously employed at Acmepay', value: 'I have not previously been employed at Acmepay', source: 'package' },
    { field: 'Gender identity', value: 'Male', source: 'standard_answer' },
    { field: 'Race/ethnicity', value: 'White', source: 'standard_answer' },
    { field: 'Veteran Status', value: "I don't wish to answer", source: 'standard_answer' },
  ],
  needsYou: [],
}

const allow = () => {
  grokBotToken(true)
  updateSettings('grokBot', { submit: true })
}
const app = (companyName: string, packageMd: string) => createApplication({ companyName, role: 'Senior Staff Software Engineer', stage: 'review', applyUrl: `https://jobs.example.com/${companyName}`, packageMd })
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const run = async (id: string) => {
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, id)).run()
  await executeTask({ ...task(id), status: 'running' })
  return task(id)
}
const check = (filled: { field: string; value: string; source?: 'standard_answer' | 'package' | 'profile' | 'resume' | 'ai_generated'; options?: string[] }[], packageMd = ACMEPAY, standardAnswers = STANDARD) =>
  checkFill({ filled, needsYou: [], packageMd, standardAnswers, company: 'Acmepay' })

afterEach(() => {
  setSecret('grokbot-token', '')
  updateSettings('grokBot', { submit: false })
  db.delete(schema.tasks).run()
  ai.replies = []
  ai.prompts = []
})

describe('reading the package', () => {
  test('answers the package marks confirm, default or inferred are unconfirmed; open questions are listed', () => {
    const p = readPackage(ACMEPAY)
    const flag = (q: string) => p.answers.find((a) => a.question.startsWith(q))?.flag ?? null
    expect(flag('Pronouns')).toBe('confirm')
    expect(flag('How did you first learn')).toMatch(/default|confirm/)
    expect(flag('First Name')).toBeNull()
    expect(flag('Do you require immigration')).toBeNull()
    expect(p.answers.find((a) => a.question === 'Pronouns')?.required).toBe(true)
    expect(p.answers.find((a) => a.question === 'Cover letter')?.flag).toBeNull()
    expect(p.pending).toHaveLength(5)
    expect(p.pending.join('\n')).not.toContain('Salary: none asked')
  })

  test('a TODO left in a written answer or the cover letter is unconfirmed', () => {
    const p = readPackage('## Application form\n\n### Q1: Why us?\nBecause [TODO: a real reason].\n\n## Cover letter\nDear team, TODO\n')
    expect(p.answers.map((a) => [a.question, !!a.flag])).toEqual([
      ['Why us?', true],
      ['Cover letter', true],
    ])
  })
})

describe('the Acmepay dry run', () => {
  test('pronouns "(confirm)" and how-did-you-hear "default; confirm" come back as questions with their options, not ready', async () => {
    allow()
    setDoc('answers', STANDARD)
    const a = app('Acmepay', ACMEPAY)
    const t = requestSubmit(a.id, { dryRun: true })
    ai.replies = [acmepayFill]
    await run(t.id)
    const s = submissions(a.id)[0]!
    expect(s.status).toBe('questions')
    expect(s.questions).toEqual([
      expect.objectContaining({ question: 'Pronouns', options: PRONOUNS }),
      expect.objectContaining({ question: 'How did you first learn about Acmepay', options: HEARD }),
    ])
    // The audit is stored with the attempt and comes back from submission_status.
    const byField = Object.fromEntries(s.audit.map((e) => [e.field, e]))
    expect(s.audit).toHaveLength(acmepayFill.filled.length)
    expect(byField.Pronouns).toMatchObject({ value: 'He/him/his', source: 'unconfirmed', confirmed: false })
    expect(byField['How did you first learn about Acmepay']).toMatchObject({ source: 'unconfirmed', confirmed: false })
    expect(byField['Resume/CV']).toMatchObject({ source: 'resume', confirmed: true })
    expect(byField['Current Company']).toMatchObject({ source: 'package', confirmed: true })
    expect(byField['Gender identity']).toMatchObject({ source: 'standard_answer', confirmed: true })
    expect(byField['Veteran Status']).toMatchObject({ source: 'standard_answer', confirmed: true })
    expect(getApplication(a.id)!.nextAction).toMatch(/2 questions/)
  })

  test("once they answer, the same fill is confirmed, and the self-identification answer goes to Standard answers", () => {
    setDoc('answers', STANDARD)
    const a = app('Acmepay2', ACMEPAY)
    answerFormQuestions(a.id, [
      { question: 'Pronouns', answer: 'He/him/his' },
      { question: 'How did you first learn about Acmepay', answer: 'I have used Acmepay as a product' },
    ])
    expect(docBody('answers')).toContain('**Pronouns** He/him/his')
    expect(docBody('answers')).not.toContain('first learn')
    const filled = acmepayFill.filled.map((f) => (f.field.startsWith('How did') ? { ...f, value: 'I have used Acmepay as a product' } : f)) as Parameters<typeof check>[0]
    const r = check(filled, getApplication(a.id)!.packageMd!, docBody('answers'))
    expect(r.questions).toEqual([])
    expect(r.audit.find((e) => e.field === 'Pronouns')).toMatchObject({ source: 'user_answer', confirmed: true })
    expect(submitRefusal(r.audit)).toBeNull()
  })
})

describe('self-identification questions', () => {
  test('a form saying Man matches Standard answers saying Male, but only as the whole answer', () => {
    const r = check([
      { field: 'Gender identity', value: 'Man', source: 'standard_answer' },
      { field: 'How would you describe your gender?', value: 'Woman', source: 'standard_answer' },
    ], '# Package\n')
    expect(r.audit.map((e) => e.confirmed)).toEqual([true, false])
  })

  test('filled from an explicit Standard answer: confirmed', () => {
    const r = check([
      { field: 'Gender', value: 'Male', source: 'standard_answer', options: ['Male', 'Female', 'Decline to self-identify'] },
      { field: 'Race', value: 'White', source: 'standard_answer' },
      { field: 'Are you a protected veteran?', value: 'I do not wish to answer', source: 'standard_answer' },
      { field: 'Disability status', value: "No, I don't have a disability", source: 'standard_answer' },
    ], '# Package\n')
    expect(r.audit.map((e) => [e.field, e.confirmed])).toEqual([
      ['Gender', true],
      ['Race', true],
      ['Are you a protected veteran?', true],
      // Standard answers say decline; "No" is a different answer.
      ['Disability status', false],
    ])
    expect(r.questions.map((q) => q.field)).toEqual(['Disability status'])
  })

  test('without an explicit Standard answer: a question, even when the filler calls it a standard answer', () => {
    const template = '# Standard answers\n\n- Pronouns (optional):\n- Demographic / EEO questions: (e.g. "Decline to self-identify")\n'
    const r = check(
      [
        { field: 'Gender', value: 'Male', source: 'standard_answer', options: ['Male', 'Female'] },
        { field: 'Sexual orientation', value: 'Decline to self-identify', source: 'standard_answer' },
        { field: 'Pronouns', value: 'He/him', source: 'standard_answer' },
      ],
      '# Package\n',
      template,
    )
    expect(r.audit.every((e) => !e.confirmed)).toBe(true)
    expect(r.questions).toEqual([
      expect.objectContaining({ field: 'Gender', options: ['Male', 'Female'] }),
      expect.objectContaining({ field: 'Sexual orientation' }),
      expect.objectContaining({ field: 'Pronouns' }),
    ])
  })

  test('one answer is not worked out from another: race White does not answer Hispanic/Latino', () => {
    const r = check([{ field: 'Are you Hispanic/Latino?', value: 'Decline To Self Identify', source: 'standard_answer' }])
    expect(r.audit[0]).toMatchObject({ source: 'unconfirmed', confirmed: false })
  })
})

describe('open questions in the package', () => {
  test('a field listed only under "Questions for …" or "Needs your decision" is a question, though its table answer looks fine', () => {
    const pkg = `## Questions for Sam
1. Are you open to relocating to Austin?

## Needs your decision
- [ ] Do you know anyone who works at Acme? You said No last time; check that's still true.

## Application form
| # | Question | Required | Answer | Source |
|---|---|---|---|---|
| 1 | Do you know anyone who works at Acme? | Yes | No | Answers |
| 2 | Email | Yes | sam@example.com | Answers |
`
    const r = checkFill({
      filled: [
        { field: 'Do you know anyone who works at Acme?', value: 'No', source: 'package', options: ['Yes', 'No'] },
        { field: 'Open to relocating to Austin?', value: 'Yes', source: 'package' },
        { field: 'Email', value: 'sam@example.com', source: 'profile' },
      ],
      needsYou: [],
      packageMd: pkg,
      standardAnswers: STANDARD,
      company: 'Acme',
    })
    expect(r.audit.map((e) => [e.field, e.confirmed])).toEqual([
      ['Do you know anyone who works at Acme?', false],
      ['Open to relocating to Austin?', false],
      ['Email', true],
    ])
    expect(r.questions.map((q) => q.field)).toEqual(['Do you know anyone who works at Acme?', 'Open to relocating to Austin?'])
    expect(r.questions[0]!.options).toEqual(['Yes', 'No'])
  })

  test('a required unconfirmed answer the filler skipped without listing is still asked', () => {
    const r = check([{ field: 'First Name', value: 'Sam', source: 'standard_answer' }])
    expect(r.questions.map((q) => q.field)).toEqual(['Pronouns', 'How did you first learn about Acmepay as an employer?'])
  })
})

describe('the pre-submit audit', () => {
  test('a dry run saved before fills were audited is not ready', () => {
    const a = app('Legacy', ACMEPAY)
    const t = requestSubmit(a.id, { dryRun: true })
    const { audit: _, ...old } = { ...acmepayFill, submitting: false, dryRun: true, submit: null, evidence: null, audit: undefined }
    db.update(schema.tasks).set({ status: 'done', output: JSON.stringify(old) }).where(eq(schema.tasks.id, t.id)).run()
    expect(submissions(a.id)[0]).toMatchObject({ status: 'not_submitted', audit: [] })
  })

  test('submit refuses when any filled field is unconfirmed', () => {
    expect(submitRefusal([{ field: 'Email', value: 'x', source: 'profile', confirmed: true }])).toBeNull()
    expect(submitRefusal([{ field: 'Why us?', value: 'Made up', source: 'ai_generated', confirmed: false }])).toMatch(/Why us\?/)
    expect(submitRefusal(undefined)).not.toBeNull()
  })

  test('a fill reporting ready with a made-up answer is never submitted', async () => {
    allow()
    setDoc('answers', STANDARD)
    const a = app('Initrode', '# Package\n\n### Q1 Why us?\nBecause.')
    const t = requestSubmit(a.id)
    ai.replies = [
      { outcome: 'ready', summary: 'All filled.', filled: [{ field: 'Why us?', value: 'Because.', source: 'package' }, { field: 'Favorite color', value: 'Blue', source: 'ai_generated' }], needsYou: [] },
      { outcome: 'submitted', summary: 'Should never run.', problems: [], confirmation: '' },
    ]
    await run(t.id)
    expect(ai.prompts).toHaveLength(1)
    expect(getApplication(a.id)!.stage).toBe('approved')
    const s = submissions(a.id)[0]!
    expect(s.status).toBe('questions')
    expect(s.questions.map((q) => q.question)).toEqual(['Favorite color'])
    expect(s.audit.find((e) => e.field === 'Favorite color')).toMatchObject({ source: 'ai_generated', confirmed: false })
  })

  test('a fully confirmed fill is submitted, and its audit is kept with the attempt', async () => {
    allow()
    setDoc('answers', STANDARD)
    const a = app('Vandelay', '# Package\n\n### Q1 Why us?\nBecause.')
    const t = requestSubmit(a.id)
    ai.replies = [
      { outcome: 'ready', summary: 'All filled.', filled: [{ field: 'Why us?', value: 'Because.', source: 'package' }, { field: 'Phone', value: '555-0100', source: 'standard_answer' }], needsYou: [] },
      { outcome: 'submitted', summary: 'Thanks for applying.', problems: [], confirmation: 'Thanks for applying.' },
    ]
    await run(t.id)
    expect(ai.prompts).toHaveLength(2)
    const s = submissions(a.id)[0]!
    expect(s.status).toBe('submitted')
    expect(s.audit).toEqual([
      { field: 'Why us?', value: 'Because.', source: 'package', confirmed: true },
      { field: 'Phone', value: '555-0100', source: 'standard_answer', confirmed: true },
    ])
  })
})
