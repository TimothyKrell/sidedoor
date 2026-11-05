import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'

const ai = vi.hoisted(() => ({ prompts: [] as string[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    return { text: '', data: { summary: 'Stopped.', stopped: true }, log: [], sessionId: 's', costUsd: 0, provider: 'claude', model: 'm' }
  },
}))
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), buildResumePdf: async () => ({ pages: 1 }), tailoredFor: () => ({ id: 'res_x' }) }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { toolsFor } = await import('../src/mcp/tools')
const { createApplication, getApplication } = await import('../src/services/applications')
const { docBody, setDoc } = await import('../src/services/documents')
const { answerQuestions, askQuestions, dismissQuestions, docWithAnswer, importPackageQuestions, listQuestions, packageWithAnswer, questionKey, reopenQuestion, reviseWithAnswers, savePackage } = await import('../src/services/questions')
const { enqueueTask } = await import('../src/services/tasks')
const { setMeta } = await import('../src/settings')

let n = 0
const app = (o: Partial<typeof schema.applications.$inferInsert> = {}) => createApplication({ companyName: `Co${++n}`, role: 'Engineering Manager', stage: 'review', packageMd: '# Review\n\n## Summary\nGood fit.', ...o })
const row = (id: string) => db.select().from(schema.questions).where(eq(schema.questions.id, id)).get()!

afterEach(() => {
  db.delete(schema.questions).run()
  db.delete(schema.tasks).run()
  setDoc('answers', '# Standard answers\n\n- **Pronouns** he/him\n')
  setDoc('experience', '# Experience\n\nThings I did.\n')
  ai.prompts = []
})

describe('asking', () => {
  test('the same question asked again for an application is one question, whatever its punctuation', () => {
    const a = app()
    const [q1] = askQuestions(a.id, 'prep', [{ question: '1. Have you used **GCP** in production? (yes/no)' }])
    const [q2] = askQuestions(a.id, 'prep', [{ question: 'Have you used GCP in production', why: 'JD lists it' }])
    expect(q2!.id).toBe(q1!.id)
    expect(q1!.question).toBe('Have you used GCP in production? (yes/no)')
    expect(questionKey('Have you used GCP in production? (yes/no)')).toBe('have you used gcp in production')
    expect(row(q1!.id).why).toBe('JD lists it')
    expect(listQuestions({ status: 'open' })).toHaveLength(1)
  })

  test('about you is guessed for form answers and past work, and suggested for every application', () => {
    const a = app()
    const [salary, past, job] = askQuestions(a.id, 'fill', [{ question: 'Desired salary' }, { question: 'Did you lead the SOC 2 work?' }, { question: 'Which office would you pick?' }])
    expect([row(salary!.id).about, row(salary!.id).saveTo, row(salary!.id).scope]).toEqual(['you', 'answers', 'global'])
    expect([row(past!.id).about, row(past!.id).saveTo]).toEqual(['you', 'experience'])
    expect([row(job!.id).about, row(job!.id).scope]).toEqual(['application', 'application'])
  })

  test('open in several applications, it is listed once with each application', () => {
    const a = app()
    const b = app()
    askQuestions(a.id, 'prep', [{ question: 'Are you open to relocating?' }])
    askQuestions(b.id, 'prep', [{ question: 'Are you open to relocating' }])
    const [g] = listQuestions({ status: 'open' })
    expect(g!.ids).toHaveLength(2)
    expect(g!.applications.map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })

  test('open questions of applications already sent are left out', () => {
    const a = app({ stage: 'applied' })
    askQuestions(a.id, 'prep', [{ question: 'Anything else?' }])
    expect(listQuestions({ status: 'open' })).toEqual([])
    expect(listQuestions({ status: 'open', includeSent: true })).toHaveLength(1)
  })
})

describe('answering', () => {
  test('an answer for every application answers it everywhere, goes to Standard answers, and is not asked again', () => {
    const a = app()
    const b = app()
    const [qa] = askQuestions(a.id, 'prep', [{ question: 'What base salary should forms say?', about: 'you', saveTo: 'answers' }])
    askQuestions(b.id, 'fill', [{ question: 'What base salary should forms say' }])
    const r = answerQuestions([{ id: qa!.id, answer: '$220K base', allApplications: true }], 'you')
    expect(r.applications.sort()).toEqual([a.id, b.id].sort())
    expect(listQuestions({ status: 'open' })).toEqual([])
    for (const id of [a.id, b.id]) expect(getApplication(id)!.packageMd).toContain('## Your answers to questions\n\n### What base salary should forms say')
    const doc = docBody('answers')
    expect(doc).toContain('- **Pronouns** he/him')
    expect(doc).toContain('## Answers to questions\n\n- **What base salary should forms say?** $220K base')

    // A third application asks it: answered at once, from the answer already given.
    const c = app()
    const [qc] = askQuestions(c.id, 'prep', [{ question: 'What base salary should forms say?' }])
    expect(qc).toMatchObject({ status: 'answered', answer: '$220K base', known: true })
    expect(getApplication(c.id)!.packageMd).toContain('$220K base')
    expect(row(qc!.id)).toMatchObject({ applicationId: c.id, scope: 'global', answeredBy: 'you' })
    // Asked in general, it comes back answered without a new question.
    expect(askQuestions(null, 'agent', [{ question: 'What base salary should forms say?' }])[0]).toMatchObject({ known: true, answer: '$220K base' })

    // Changing it changes the one line, not a second one.
    answerQuestions([{ id: qc!.id, answer: '$230K base' }], 'grokbot')
    expect(docBody('answers').match(/What base salary/g)).toHaveLength(1)
    expect(docBody('answers')).toContain('$230K base')
    expect(getApplication(a.id)!.packageMd).toContain('$230K base')
    expect(listQuestions({ status: 'answered' })).toHaveLength(1)
  })

  test('an answer for one application stays with it', () => {
    const a = app()
    const b = app()
    const [qa] = askQuestions(a.id, 'prep', [{ question: 'Do you know anyone on the team?' }])
    const [qb] = askQuestions(b.id, 'prep', [{ question: 'Do you know anyone on the team?' }])
    answerQuestions([{ id: qa!.id, answer: 'Yes, a former colleague', allApplications: false }], 'you')
    expect(row(qb!.id).status).toBe('open')
    expect(docBody('answers')).not.toContain('anyone on the team')
    expect(getApplication(b.id)!.packageMd).not.toContain('former colleague')
    const c = app()
    expect(askQuestions(c.id, 'prep', [{ question: 'Do you know anyone on the team?' }])[0]!.status).toBe('open')
  })

  test('facts about past work go to their own section of Experience', () => {
    const a = app()
    const [q] = askQuestions(a.id, 'prep', [{ question: 'Did you set up onboarding at the last job?', about: 'you', saveTo: 'experience' }])
    answerQuestions([{ id: q!.id, answer: 'Yes: docs, a buddy and a first-week plan.' }], 'you')
    expect(docBody('experience')).toBe('# Experience\n\nThings I did.\n\n## Answers to questions\n\n- **Did you set up onboarding at the last job?** Yes: docs, a buddy and a first-week plan.\n')
    expect(docBody('answers')).not.toContain('onboarding')
  })

  test('reopening takes an answer for every application back out everywhere; dismissing drops it', () => {
    const a = app()
    const b = app()
    const [qa] = askQuestions(a.id, 'prep', [{ question: 'Earliest start date?', about: 'you' }])
    askQuestions(b.id, 'prep', [{ question: 'Earliest start date?' }])
    answerQuestions([{ id: qa!.id, answer: 'Two weeks' }], 'you')
    reopenQuestion(qa!.id)
    expect(listQuestions({ status: 'open' })[0]!.ids).toHaveLength(2)
    expect(docBody('answers')).not.toContain('Earliest start date')
    expect(getApplication(a.id)!.packageMd).not.toContain('Two weeks')
    expect(getApplication(a.id)!.packageMd).not.toContain('Your answers to questions')

    answerQuestions([{ id: qa!.id, answer: 'Two weeks', allApplications: false }], 'you')
    dismissQuestions([qa!.id], 'you')
    expect(row(qa!.id).status).toBe('dismissed')
    expect(getApplication(a.id)!.packageMd).not.toContain('Two weeks')
    // Dismissed isn't asked again for that application.
    expect(askQuestions(a.id, 'prep', [{ question: 'Earliest start date?' }])[0]!.status).toBe('dismissed')
  })

  test('an empty answer is refused', () => {
    const [q] = askQuestions(app().id, 'prep', [{ question: 'Why this company?' }])
    expect(() => answerQuestions([{ id: q!.id, answer: '  ' }], 'you')).toThrow(/Give an answer/)
  })
})

describe('packages', () => {
  const PKG = `# Review: Acme - EM

## Questions for you
1. Did any integration touch **FHIR**? (yes/no)
2. Have you used GCP in production? (yes/no)
   - **Answered Oct 30, 2026 (saved in Experience):** Some GCP and BigQuery.

## 30-second summary
- Fine.
`

  test("a saved package's questions section becomes questions, and answers already given stay in a new package", () => {
    const a = app({ packageMd: null })
    savePackage(a.id, PKG)
    const qs = listQuestions({ applicationId: a.id, status: 'all' })
    expect(qs.map((q) => [q.question, q.status, q.answeredBy])).toEqual(
      expect.arrayContaining([
        ['Did any integration touch FHIR? (yes/no)', 'open', null],
        ['Have you used GCP in production? (yes/no)', 'answered', 'package'],
      ]),
    )
    const fhir = qs.find((q) => q.status === 'open')!
    answerQuestions([{ id: fhir.id, answer: 'No', allApplications: false }], 'you')
    // The AI rewrites the package without the answer: it's put back.
    savePackage(a.id, '# Review: Acme - EM\n\n## 30-second summary\n- Revised.\n')
    expect(getApplication(a.id)!.packageMd).toBe('# Review: Acme - EM\n\n## 30-second summary\n- Revised.\n\n## Your answers to questions\n\n### Did any integration touch FHIR? (yes/no)\nNo\n')
  })

  test('packages saved before questions were kept are imported once, for applications not sent yet', () => {
    const a = app({ packageMd: PKG })
    app({ packageMd: PKG, stage: 'closed' })
    setMeta('questionsImported', false)
    expect(importPackageQuestions()).toBe(1)
    expect(importPackageQuestions()).toBe(0)
    expect(listQuestions({ status: 'all', includeSent: true }).flatMap((q) => q.applications.map((x) => x.id))).toEqual([a.id, a.id])
  })

  test('the package section keeps blocks in place and the doc keeps the rest of the document', () => {
    const md = packageWithAnswer(packageWithAnswer('# P\n\n## Your answers to questions\n\n### A\nold\n\n## Uploads\n- x\n', 'B', 'two'), 'A', 'new')
    expect(md).toBe('# P\n\n## Your answers to questions\n\n### A\nnew\n\n### B\ntwo\n\n## Uploads\n- x\n')
    expect(packageWithAnswer(md, 'A', null)).toBe('# P\n\n## Your answers to questions\n\n### B\ntwo\n\n## Uploads\n- x\n')
    expect(docWithAnswer('', 'Q', 'a')).toBe('## Answers to questions\n\n- **Q** a\n')
  })

  test('a targeted revision sends only the new answers, once', () => {
    const a = app()
    const [q] = askQuestions(a.id, 'prep', [{ question: 'Have you used Apollo?' }])
    expect(() => reviseWithAnswers(a.id)).toThrow(/No new answers/)
    answerQuestions([{ id: q!.id, answer: 'Yes, at the last job', allApplications: false }], 'you')
    expect(listQuestions({ applicationId: a.id, status: 'answered' })[0]!.unrevised).toBe(true)
    expect(reviseWithAnswers(a.id)).toEqual({ answers: 1 })
    const t = db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).get()!
    expect(t).toMatchObject({ kind: 'prep', input: { revision: true } })
    expect(getApplication(a.id)!.reviewNotes).toMatch(/Targeted update[\s\S]*Q: Have you used Apollo\?\n {2}A: Yes, at the last job/)
    expect(listQuestions({ applicationId: a.id, status: 'answered' })[0]!.unrevised).toBe(false)
    expect(() => reviseWithAnswers(a.id)).toThrow(/No new answers/)
  })

  test("prep is told the answers already given, for every application and for this one", async () => {
    const a = app()
    const b = app()
    const [g] = askQuestions(b.id, 'prep', [{ question: 'Earliest start date?', about: 'you' }])
    answerQuestions([{ id: g!.id, answer: 'Two weeks' }], 'you')
    const [own] = askQuestions(a.id, 'prep', [{ question: 'Which team do you prefer?' }])
    answerQuestions([{ id: own!.id, answer: 'Platform', allApplications: false }], 'you')
    const [other] = askQuestions(b.id, 'prep', [{ question: 'Do you know the founder?' }])
    answerQuestions([{ id: other!.id, answer: 'No', allApplications: false }], 'you')
    const t = enqueueTask('prep', 'Prep', { applicationId: a.id, priority: 10, dedupe: false })
    db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
    await executeTask({ ...t, status: 'running', attempts: 1 })
    expect(ai.prompts[0]).toContain('- Earliest start date? → Two weeks')
    expect(ai.prompts[0]).toContain('- Which team do you prefer? → Platform')
    expect(ai.prompts[0]).not.toContain('founder')
    expect(ai.prompts[0]).toContain('ask_questions')
  })
})

test('agents get the question tools, and answer through them as themselves', async () => {
  const tools = toolsFor('app')
  expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_questions', 'ask_questions', 'answer_user_questions', 'dismiss_questions']))
  const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await tools.find((t) => t.name === name)!.handler(args)).content[0]!.text) as Record<string, unknown>
  const a = app()
  const asked = (await call('ask_questions', { applicationId: a.id, questions: [{ question: 'Are you a US citizen?', options: ['Yes', 'No'] }] })) as { questions: { id: string }[] }
  const [listed] = (await call('list_questions', { applicationId: a.id })) as unknown as { id: string; options: string[] }[]
  expect(listed).toMatchObject({ id: asked.questions[0]!.id, options: ['Yes', 'No'] })
  await call('answer_user_questions', { answers: [{ questionId: listed!.id, answer: 'Yes' }], relayedBy: 'grokbot', revise: true })
  expect(row(listed!.id)).toMatchObject({ status: 'answered', answeredBy: 'grokbot', scope: 'global' })
  expect(db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).get()?.kind).toBe('prep')
})
