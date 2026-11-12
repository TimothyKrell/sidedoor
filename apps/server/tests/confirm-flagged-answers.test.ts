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
const { answerFormQuestions, answerQuestions, askQuestions, dismissQuestions, listQuestions, settledFor } = await import('../src/services/questions')
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

  test('a bare Yes/No goes in when Standard answers start that question\'s answer with it', () => {
    const std = `| Field | Answer |\n|---|---|\n| EEO | Race/ethnicity: White. Hispanic/Latino: **No** (pick "No"). Veteran status: **not a veteran**. Disability: decline to self-identify |\n`
    const r = check(
      [
        { field: 'Are you Hispanic/Latino?', value: 'No', source: 'standard_answer' },
        { field: 'Are you a protected veteran?', value: 'No', source: 'standard_answer' },
        { field: 'Are you Hispanic or Latino?', value: 'Yes', source: 'standard_answer' },
        { field: 'Do you have a disability?', value: 'No', source: 'standard_answer' },
      ],
      '# Package\n',
      std,
    )
    expect(r.audit.map((e) => e.confirmed)).toEqual([true, true, false, false])
  })

  test('a no in the form\'s own words goes in when Standard answers say no', () => {
    const std = `| Field | Answer |\n|---|---|\n| EEO | Veteran status: **not a veteran** (pick "I am not a protected veteran" / "No"). Disability: decline to self-identify |\n`
    const r = check(
      [
        { field: 'Are you a veteran or active member of the United States Armed Forces?', value: 'No, I am not a veteran or active member', source: 'standard_answer' },
        { field: 'Veteran status', value: 'I am not a veteran', source: 'standard_answer' },
        { field: 'Protected veteran?', value: 'No, but I am a veteran', source: 'standard_answer' },
        { field: 'Do you have a disability?', value: "No, I don't have a disability", source: 'standard_answer' },
      ],
      '# Package\n',
      std,
    )
    expect(r.audit.map((e) => e.confirmed)).toEqual([true, true, false, false])
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

// Shaped like real packages: a stray word in an open item held a contact field.
const STRAY = `## Questions for Sam
1. Do you have one backend hot-path story? One line, with before/after numbers if you have them.
2. Which Solana project did you deploy programs for, and were they written in Rust/Anchor? (yes/no + project name)
3. What did you build in Rails, and for how long? (Rails is the first stack the JD names.)

- **Answered Oct 30, 2026 (saved in Experience):** Rust. You've used Rust in the indexers.

## Needs your decision
- [ ] The cover letter says "I still write code most of the week." Confirm it still holds.
- [ ] Open to relocating to Austin? You said no last time.

## Application form
| # | Question | Required | Answer | Source |
|---|---|---|---|---|
| 1 | Name | Yes | Sam Example | Answers |
| 2 | Email | Yes | sam@example.com | Answers |
`
const field = (name: string, value: string, source: 'standard_answer' | 'package' | 'profile' | 'ai_generated' = 'package') => ({ field: name, value, source })
const held = (r: ReturnType<typeof check>) => r.audit.filter((e) => !e.confirmed).map((e) => e.field)

describe('open items only hold the field they are about', () => {
  test('a stray word in an item holds no contact field, and scattered words are not a label', () => {
    const r = check([field('Name', 'Sam Example'), field('Name*', 'Sam Example'), field('First Name', 'Sam'), field('Email', 'sam@example.com'), field('Phone Number', '555-0100')], STRAY)
    expect(held(r)).toEqual([])
    expect(r.questions).toEqual([])
  })

  test('a field an item really is about stays held, and the question quotes the item', () => {
    const r = check([field('Cover Letter', 'Dear team'), field('Open to relocating to Austin, TX?', 'No')], STRAY)
    expect(held(r)).toEqual(['Cover Letter', 'Open to relocating to Austin, TX?'])
    expect(r.questions[0]!.why).toContain('The cover letter says')
  })

  test('a short label that is not contact details still matches as a phrase', () => {
    const r = check([field('Preferred Name', 'Sam')], '## Needs your decision\n- [ ] Preferred name: should it be Sam or Samuel?\n')
    expect(held(r)).toEqual(['Preferred Name'])
  })

  test('an explicit mark in the package still holds a contact field', () => {
    const r = check([field('Email', 'sam@example.com')], '## Application form\n| Question | Required | Answer | Source |\n|---|---|---|---|\n| Email | Yes | sam@example.com (confirm) | Answers |\n')
    expect(held(r)).toEqual(['Email'])
  })

  test('an "Answered" note is not an open item, and closes the question it sits under', () => {
    const p = readPackage('## Questions for Sam\n1. Did you use Rust?\n   - **Answered Oct 30:** Yes.\n2. Did you use Kafka?\n\n- **Answered Oct 30, 2026:** Rust, in the indexers.\n')
    expect(p.pending).toEqual(['Did you use Kafka?'])
  })

  test('an answer to a short question confirms that field, not every longer label around it', () => {
    const pkg = '## Your answers to questions\n\n### Name\nSam Example\n\n### How did you first learn about Acmepay\nA friend\n'
    const r = check([field('Name*', 'Sam Example'), field('Emergency contact name', 'Sam Example', 'ai_generated'), field('How did you first learn about Acmepay as an employer?', 'A friend')], pkg)
    expect(r.audit.map((e) => [e.field, e.source])).toEqual([
      ['Name*', 'user_answer'],
      ['Emergency contact name', 'ai_generated'],
      ['How did you first learn about Acmepay as an employer?', 'user_answer'],
    ])
  })
})

describe('what the user already settled', () => {
  const ITEM = '## Questions for Sam\n1. Are you open to relocating to Austin? It decides the location line.\n'
  const fill = (id: string, value = 'No') => checkFill({ filled: [field('Open to relocating to Austin?', value)], needsYou: [], packageMd: ITEM, standardAnswers: STANDARD, company: 'Acme', settled: settledFor(id) })

  test('a dropped question stops holding its field, though its text is still in the package', () => {
    const a = app('Settled1', ITEM)
    const [q] = askQuestions(a.id, 'package', [{ question: 'Are you open to relocating to Austin?' }])
    expect(fill(a.id).audit[0]!.confirmed).toBe(false)
    dismissQuestions([q!.id], 'agent')
    expect(fill(a.id).audit[0]!.confirmed).toBe(true)
  })

  test('your Not needed lets through the value you saw, and a different value asks again', () => {
    const a = app('Settled2', '## Needs your decision\n- [ ] Open to relocating to Austin? Check this still holds.\n')
    const md = getApplication(a.id)!.packageMd
    const check2 = (value: string) => checkFill({ filled: [field('Open to relocating to Austin?', value)], needsYou: [], packageMd: md, standardAnswers: STANDARD, company: 'Acme', settled: settledFor(a.id) })
    const [q] = askQuestions(a.id, 'fill', [{ question: 'Open to relocating to Austin?', filledValue: 'No' }])
    dismissQuestions([q!.id], 'you')
    expect(check2('No').audit[0]!.confirmed).toBe(true)
    expect(check2('Yes').audit[0]!.confirmed).toBe(false)
  })

  test("an agent's dismissal doesn't let a held value through", () => {
    const a = app('Settled3', '## Needs your decision\n- [ ] Open to relocating to Austin? Check this still holds.\n')
    const [q] = askQuestions(a.id, 'fill', [{ question: 'Open to relocating to Austin?', filledValue: 'No' }])
    dismissQuestions([q!.id], 'agent')
    const r = checkFill({ filled: [field('Open to relocating to Austin?', 'No')], needsYou: [], packageMd: getApplication(a.id)!.packageMd, standardAnswers: STANDARD, company: 'Acme', settled: settledFor(a.id) })
    expect(r.audit[0]!.confirmed).toBe(false)
  })

  test("Not needed never passes a marked, self-identification or made-up answer", () => {
    const a = app('Settled4', ACMEPAY)
    const fields = [field('Pronouns', 'He/him/his'), field('Veteran status', 'Yes'), field('Favorite color', 'Blue', 'ai_generated')]
    for (const f of fields) dismissQuestions([askQuestions(a.id, 'fill', [{ question: f.field, filledValue: f.value }])[0]!.id], 'you')
    const r = checkFill({ filled: fields, needsYou: [], packageMd: ACMEPAY, standardAnswers: STANDARD, company: 'Acmepay', settled: settledFor(a.id) })
    expect(r.audit.every((e) => !e.confirmed)).toBe(true)
  })

  test('a form still waiting on a question you passed on shows it again, with what was filled', () => {
    const a = app('Settled5', ACMEPAY)
    const [q] = askQuestions(a.id, 'fill', [{ question: 'Name', filledValue: 'Sam' }])
    dismissQuestions([q!.id], 'you')
    expect(askQuestions(a.id, 'fill', [{ question: 'Name*', filledValue: 'Samuel' }])[0]).toMatchObject({ id: q!.id, status: 'open', known: false })
    expect(listQuestions({ applicationId: a.id, status: 'open' })[0]).toMatchObject({ question: 'Name', filledValue: 'Samuel' })
  })

  test('the same field held with different values stays two questions, so Use this answers the right one', () => {
    const [a, b] = [app('Settled6', ACMEPAY), app('Settled7', ACMEPAY)]
    askQuestions(a.id, 'fill', [{ question: 'Nickname', filledValue: 'Sam' }])
    askQuestions(b.id, 'fill', [{ question: 'Nickname', filledValue: 'Sammy' }])
    const open = listQuestions({ status: 'open' }).filter((g) => g.question === 'Nickname')
    expect(open.map((g) => g.filledValue).sort()).toEqual(['Sam', 'Sammy'])
    answerQuestions(open.map((g) => ({ id: g.id, answer: g.filledValue!, allApplications: false })), 'you')
  })

  test('passing on the last question a form held queues the fill again, and the held value is on the row', async () => {
    allow()
    setDoc('answers', STANDARD)
    const a = app('Settled8', '## Needs your decision\n- [ ] Open to relocating to Austin? Check this still holds.\n')
    const t = requestSubmit(a.id, { dryRun: true })
    ai.replies = [{ outcome: 'ready', summary: 'Filled.', filled: [field('Open to relocating to Austin?', 'No')], needsYou: [] }]
    await run(t.id)
    const [g] = listQuestions({ applicationId: a.id, status: 'open' })
    expect(g).toMatchObject({ question: 'Open to relocating to Austin?', filledValue: 'No' })
    expect(g!.why).toContain('Check this still holds')
    expect(dismissQuestions(g!.ids, 'you').resubmitted).toEqual([a.id])
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
