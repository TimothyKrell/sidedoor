import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { reviewBucket, type ReviewFacts, textMark, writingItems } from '@sidedoor/shared/review'
import type { ResumeMatch } from '@sidedoor/shared/match'

// The AI's replies, in order, and a hook to stand in for what it does to the resume.
const ai = vi.hoisted(() => ({ replies: [] as unknown[], prompts: [] as string[], act: null as null | (() => void) }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    ai.act?.()
    return { text: '', data: ai.replies.shift(), log: ['step'], sessionId: 'sess_1', costUsd: 0.01, provider: 'claude', model: 'm' }
  },
}))
const tab = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('../src/browser', async (orig) => ({
  ...(await orig<typeof import('../src/browser')>()),
  openFormTab: async () => ({
    cdpEndpoint: 'ws://x',
    finish: async () => void tab.calls.push('finish'),
    unguard: async () => void tab.calls.push('unguard'),
    close: async () => void tab.calls.push('close'),
  }),
}))
vi.mock('../src/mcp/playwright', () => ({ withBrowserTools: (_e: string, _d: string, fn: () => Promise<unknown>) => fn() }))
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => 'Page URL: https://x/thanks' }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))
// Scores come from the test: each match check reads the next one.
const scores = vi.hoisted(() => ({ next: [] as number[], requirements: [] as unknown[] }))
vi.mock('../src/match', async (orig) => ({
  ...(await orig<typeof import('../src/match')>()),
  runMatch: async (id: string) => {
    const match = { score: scores.next.shift() ?? 0, requirements: scores.requirements, summary: '', at: '', model: 'm', doc: '', resumeVersion: '1' } as unknown as ResumeMatch
    const { setResumeMatch } = await import('../src/services/applications')
    setResumeMatch(id, match)
    return { match, reused: false, costUsd: 0, log: [] }
  },
}))
const pdf = join(mkdtempSync(join(tmpdir(), 'sd-pdf-')), 'Resume.pdf')
writeFileSync(pdf, '%PDF')
const pages = vi.hoisted(() => ({ n: 1 }))
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), buildResumePdf: async () => ({ path: pdf, pages: pages.n }) }))

const { db, schema } = await import('../src/db/client')
const { applicationThread } = await import('../src/chat')
const { executeTask } = await import('../src/jobs/tasks')
const { reviewQueue, tuneAll } = await import('../src/review')
const { toolsFor } = await import('../src/mcp/tools')
const { createApplication, getApplication, requestSubmit, setResumeTune, setWriting, settleDecisions } = await import('../src/services/applications')
const { answerQuestions, askQuestions, listQuestions } = await import('../src/services/questions')
const { baseResume, createResume, requireResume, saveContent, tailoredFor } = await import('../src/services/resumes')
const { enqueueTask } = await import('../src/services/tasks')
const { getSettings } = await import('../src/settings')

const PACKAGE = `# Review

## Needs your decision
- [ ] Salary number
- [ ] Start date

## Application form
| # | Question | Required | Answer | Source |
|---|---|---|---|---|
| 1 | Why us? | Yes | see below | Experience |

### Q1: Why us?
I have spent years building exactly the sort of thing this team builds.

### Q2: A hard call you made
[You write this]

## Cover letter
Not requested by this form.
`

const app = (companyName: string, o: Partial<typeof schema.applications.$inferInsert> = {}) =>
  createApplication({ companyName, role: 'Engineer', stage: 'review', applyUrl: `https://jobs.example.com/${companyName}`, packageMd: PACKAGE, ...o })
const tune = (id: string, from = 80, to = 90) => setResumeTune(id, { at: '2026-11-05T10:00:00.000Z', from, to, rounds: 2, stopped: 'no_gain', summary: 'Moved the migration up.' })
const item = (id: string) => reviewQueue().find((x) => x.id === id)!
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!

afterEach(() => {
  ai.replies = []
  ai.prompts = []
  ai.act = null
  scores.next = []
  pages.n = 1
  tab.calls = []
  db.delete(schema.tasks).run()
})

const facts = (o: Partial<ReviewFacts> = {}): ReviewFacts => ({ stage: 'review', aiWorking: false, tuned: true, openQuestions: 0, openDecisions: 0, writingLeft: 0, sending: false, stuck: false, ...o })

describe('the step an application is on', () => {
  test('earliest unfinished step wins, and an AI at work means nothing for you yet', () => {
    expect(reviewBucket(facts({ tuned: false, openQuestions: 2, writingLeft: 1 }))).toBe('tune')
    expect(reviewBucket(facts({ openQuestions: 2, writingLeft: 1 }))).toBe('answers')
    expect(reviewBucket(facts({ writingLeft: 1 }))).toBe('writing')
    expect(reviewBucket(facts())).toBe('ready')
    expect(reviewBucket(facts({ aiWorking: true, openQuestions: 2 }))).toBe('ai')
    expect(reviewBucket(facts({ sending: true, aiWorking: true }))).toBe('sending')
    expect(reviewBucket(facts({ stuck: true }))).toBe('stuck')
  })

  test('the queue counts what is open, and a dry run that stopped short is not stuck', () => {
    const a = app('Queue')
    tune(a.id)
    askQuestions(a.id, 'fill', [{ question: 'Have you used Rust in production?' }])
    const i = item(a.id)
    expect(i.facts).toMatchObject({ openQuestions: 1, openDecisions: 2, writingLeft: 2, tuned: true })
    expect(i.bucket).toBe('answers')
  })
})

describe('written answers', () => {
  test('short and blank answers are listed, and a placeholder counts as blank', () => {
    const items = writingItems(PACKAGE, {})
    expect(items.map((w) => [w.key, w.blank])).toEqual([['q:1', false], ['q:2', true]])
  })

  test('a check-off holds only for the text you checked', () => {
    const a = app('Checks')
    setWriting(a.id, 'q:1', { done: true })
    const checked = getApplication(a.id)!
    expect(writingItems(checked.packageMd, checked.writingChecks).find((w) => w.key === 'q:1')?.done).toBe(true)
    const revised = checked.packageMd!.replace('exactly the sort of thing', 'the very thing')
    expect(writingItems(revised, checked.writingChecks).find((w) => w.key === 'q:1')?.done).toBe(false)
  })

  test('your own text goes into the package, and a blank one cannot be checked off', () => {
    const a = app('Mine')
    expect(() => setWriting(a.id, 'q:2', { done: true, text: '  ' })).toThrow(/Write the answer/)
    setWriting(a.id, 'q:2', { done: true, text: 'The hard call was shutting down our own product.' })
    const after = getApplication(a.id)!
    expect(after.packageMd).toContain('The hard call was shutting down our own product.')
    expect(after.packageMd).not.toContain('[You write this]')
    expect(after.writingChecks?.['q:2']).toBe(textMark('The hard call was shutting down our own product.'))
  })

  test('an optional question leaves the application where it is, and shows how many there are', () => {
    const a = app('Optional')
    settleDecisions(a.id)
    const before = item(a.id).bucket
    askQuestions(a.id, 'tune', [{ question: 'Have you used Fastify?', about: 'you', saveTo: 'experience' }])
    expect(item(a.id)).toMatchObject({ bucket: before, optionalQuestions: 1, facts: { openQuestions: 0 } })
    askQuestions(a.id, 'fill', [{ question: 'Desired salary' }])
    expect(item(a.id).facts.openQuestions).toBe(1)
  })

  test('all fine as is settles every open decision', () => {
    const a = app('Settle')
    expect(settleDecisions(a.id)).toBe(2)
    expect(item(a.id).facts.openDecisions).toBe(0)
  })
})

describe('tuning the resume', () => {
  const ready = (name: string) => {
    if (!baseResume()) createResume({ title: 'Main', isBase: true } as never)
    const a = app(name)
    tailoredFor(a.id)
    return getApplication(a.id)!
  }
  const run = async (id: string) => {
    const t = enqueueTask('tune', 'Tune', { applicationId: id })
    await executeTask(t)
    return task(t.id)
  }

  describe('what it asks', () => {
    const asks = (n: number, requirement = 'r1') => Array.from({ length: n }, (_, i) => ({ question: `Have you done thing ${i}?`, why: 'It would close the gap.', requirement }))
    const reply = (questions: unknown[]) => [{ summary: 'Done.', rounds: 1, stopped: 'no_more_facts', questions }]
    const need = (id: string, kind: string, level: string) => ({ id, kind, level, short: id, quote: '', evidence: [], note: '', fix: null })
    const tuneAsked = (id: string) => listQuestions({ status: 'open', applicationId: id })
    const finished = async (id: string) => expect((await run(id)).status).toBe('done')
    afterEach(() => void (scores.requirements = []))

    test('two at most, optional, for a must-have that is short', async () => {
      const a = ready('Asks')
      scores.requirements = [need('r1', 'must', 'partial')]
      scores.next = [70, 80]
      ai.replies = reply(asks(5))
      await finished(a.id)
      expect(tuneAsked(a.id).map((q) => [q.askedBy, q.optional])).toEqual([['tune', true], ['tune', true]])
      expect(item(a.id).facts.openQuestions).toBe(0)
    })

    test('nothing for a nice-to-have, a must-have already strong, or a requirement it made up', async () => {
      const a = ready('Nice')
      scores.requirements = [need('r1', 'nice', 'missing'), need('r2', 'must', 'strong')]
      scores.next = [70, 80]
      ai.replies = reply([...asks(1, 'r1'), ...asks(1, 'r2'), ...asks(1, 'r9')])
      await finished(a.id)
      expect(tuneAsked(a.id)).toHaveLength(0)
    })

    test('nothing once the match is good enough', async () => {
      const a = ready('Good enough')
      scores.requirements = [need('r1', 'must', 'partial')]
      scores.next = [80, 90]
      ai.replies = reply(asks(2))
      await finished(a.id)
      expect(tuneAsked(a.id)).toHaveLength(0)
    })

    test('it sees what was already asked', async () => {
      const a = ready('Knows')
      askQuestions(a.id, 'agent', [{ question: 'Have you used Azure?', about: 'you', saveTo: 'experience' }])
      scores.next = [80, 80]
      ai.replies = reply([])
      await finished(a.id)
      expect(ai.prompts.at(-1)).toContain('- Waiting: Have you used Azure?')
    })
  })

  test('records where it started and finished, measured by Sidedoor', async () => {
    const a = ready('Tuned')
    scores.next = [80, 91]
    ai.replies = [{ summary: 'Moved the migration up.', rounds: 3, stopped: 'no_more_facts' }]
    const t = await run(a.id)
    expect(t.status).toBe('done')
    expect(getApplication(a.id)!.tuneJson).toMatchObject({ from: 80, to: 91, rounds: 3, stopped: 'no_more_facts' })
    expect(ai.prompts[0]).toContain('Never invent facts')
  })

  test('at the target already, it spends no AI on it', async () => {
    const a = ready('Already')
    scores.next = [96]
    await run(a.id)
    expect(ai.prompts).toEqual([])
    expect(getApplication(a.id)!.tuneJson).toMatchObject({ from: 96, to: 96, rounds: 0, stopped: 'target' })
  })

  test('a pass that leaves the score lower puts the resume back', async () => {
    const a = ready('Worse')
    const before = requireResume(a.resumeId!).content
    scores.next = [85, 70, 85]
    ai.replies = [{ summary: 'Rewrote the summary.', rounds: 1, stopped: 'no_gain' }]
    ai.act = () => void saveContent(a.resumeId!, { ...before, ...({ summary: 'worse' } as object) } as never, { by: 'agent' })
    await run(a.id)
    expect(requireResume(a.resumeId!).content).toEqual(before)
    expect(getApplication(a.id)!.tuneJson).toMatchObject({ from: 85, to: 85, reverted: true })
  })

  test('a resume over the page limit fails the task rather than passing as tuned', async () => {
    const a = ready('Long')
    pages.n = 9
    scores.next = [80, 90]
    ai.replies = [{ summary: 'Added bullets.', rounds: 1, stopped: 'limit' }]
    const t = await run(a.id)
    expect(t.status).toBe('failed')
    expect(t.error).toContain('pages')
    expect(getApplication(a.id)!.tuneJson).toBeNull()
  })

  test('tune all queues only the untuned, once each', () => {
    const before = reviewQueue().filter((x) => !x.facts.tuned).length
    const a = app('Fresh')
    const b = app('Done')
    tune(b.id)
    expect(tuneAll().queued).toBe(before + 1)
    tuneAll()
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).all()).toHaveLength(1)
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, b.id)).all()).toHaveLength(0)
  })
})

describe("an application's own chat", () => {
  const messages = (threadId: string) => db.select().from(schema.chatMessages).where(eq(schema.chatMessages.threadId, threadId)).all()
  const text = (m: ReturnType<typeof messages>[number]) => m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')

  test('opens with the match and the questions, and costs no AI', () => {
    const a = app('Chatty')
    tune(a.id, 72, 88)
    askQuestions(a.id, 'agent', [{ question: 'Did you run the Kubernetes migration?', why: 'Top must-have.' }])
    const { threadId } = applicationThread(a.id)
    const [first] = messages(threadId)
    expect(text(first!)).toContain('72 → 88')
    expect(text(first!)).toContain('Did you run the Kubernetes migration?')
    expect(ai.prompts).toEqual([])
  })

  test('is the same chat every time, and a newer pass adds its findings', () => {
    const a = app('Again')
    tune(a.id)
    const { threadId } = applicationThread(a.id)
    expect(applicationThread(a.id).threadId).toBe(threadId)
    expect(messages(threadId)).toHaveLength(1)
    setResumeTune(a.id, { at: '2026-11-06T10:00:00.000Z', from: 90, to: 93, rounds: 1, stopped: 'no_gain', summary: 'Tightened it.' })
    expect(applicationThread(a.id).threadId).toBe(threadId)
    expect(messages(threadId)).toHaveLength(2)
  })
})

describe('submitting', () => {
  const FILL = { outcome: 'ready', summary: 'Filled.', filled: [], needsYou: [] }
  const SENT = { outcome: 'submitted', summary: 'It went in.', problems: [], confirmation: 'Thanks' }

  test('your press submits, with Grok Bot off', async () => {
    expect(getSettings().grokBot.submit).toBe(false)
    const a = app('Pressed', { resumeId: null })
    const t = requestSubmit(a.id, { by: 'you' })
    expect(getApplication(a.id)!.stage).toBe('approved')
    ai.replies = [FILL, SENT]
    await executeTask(t)
    expect(tab.calls).toContain('unguard')
    const after = getApplication(a.id)!
    expect(after.stage).toBe('applied')
    expect(task(t.id).status).toBe('done')
  })

  test('a Grok Bot request with its permission off still only fills', async () => {
    const a = app('NotAllowed', { resumeId: null })
    const t = requestSubmit(a.id)
    ai.replies = [FILL]
    await executeTask(t)
    expect(tab.calls).not.toContain('unguard')
    expect(getApplication(a.id)!.stage).toBe('approved')
  })

  test('your press respects a company limit you set', async () => {
    const { companyLimitProblem } = await import('../src/jobs/submit-batch')
    const { updateSettings } = await import('../src/settings')
    createApplication({ companyName: 'Limited', role: 'One', stage: 'applied', appliedAt: new Date().toISOString() })
    const a = app('Limited', { role: 'Two' })
    expect(companyLimitProblem(a)).toBeNull()
    updateSettings('grokBot', { companyLimits: [{ company: 'Limited', max: 1, days: 30 }] })
    expect(companyLimitProblem(a)).toMatch(/Limited limit: 1 per 30 days/)
    updateSettings('grokBot', { companyLimits: [] })
  })

  test('no agent tool can act as your press', () => {
    const app = toolsFor('app').map((t) => t.name)
    const grok = toolsFor('grokbot').map((t) => t.name)
    for (const names of [app, grok]) expect(names).not.toContain('submit_application')
    const start = toolsFor('app').find((t) => t.name === 'start_task')!
    expect(Object.keys(start.inputSchema)).not.toContain('input')
  })

  test('answering the last question a form asked sends your submit on', () => {
    const a = app('Asked', { resumeId: null })
    const t = requestSubmit(a.id, { by: 'you' })
    db.update(schema.tasks).set({ status: 'done', output: JSON.stringify({ outcome: 'needs_you', summary: 's', filled: [], needsYou: [{ field: 'Salary?', why: 'w' }] }) }).where(eq(schema.tasks.id, t.id)).run()
    const [q] = askQuestions(a.id, 'fill', [{ question: 'Salary?' }])
    const r = answerQuestions([{ id: q!.id, answer: '200000' }], 'you')
    expect(r.resubmitted).toEqual([a.id])
    const next = db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).all().find((x) => x.status === 'queued')!
    expect(next.input).toMatchObject({ submit: true, by: 'you' })
    expect(listQuestions({ status: 'open', applicationId: a.id })).toEqual([])
  })
})
