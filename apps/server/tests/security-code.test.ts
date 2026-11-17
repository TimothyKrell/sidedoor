import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'

// The AI's answers, in order. Its log repeats the prompt, as a real one would show the code it typed.
const ai = vi.hoisted(() => ({ replies: [] as unknown[], prompts: [] as string[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    return { text: '', data: ai.replies.shift(), log: [`→ browser_type ${o.prompt.match(/The code: `([^`]+)`/)?.[1] ?? 'step'}`], sessionId: 'sess_1', costUsd: 0.01, provider: 'claude', model: 'm' }
  },
}))
// `gone`: the window left open was closed, so it can't be guarded again.
const tab = vi.hoisted(() => ({ calls: [] as string[], opens: 0, gone: false }))
vi.mock('../src/browser', async (orig) => ({
  ...(await orig<typeof import('../src/browser')>()),
  openFormTab: async () => {
    tab.opens++
    return {
      cdpEndpoint: 'ws://x',
      finish: async (message?: string) => void tab.calls.push(message ? `finish: ${message}` : 'finish'),
      unguard: async () => void tab.calls.push('unguard'),
      guard: async () => {
        tab.calls.push('guard')
        if (tab.gone) throw new Error('The form window is closed')
      },
      close: async () => void tab.calls.push('close'),
    }
  },
}))
vi.mock('../src/mcp/playwright', () => ({ withBrowserTools: (_e: string, _d: string, fn: () => Promise<unknown>) => fn() }))
const pdf = join(mkdtempSync(join(tmpdir(), 'sd-pdf-')), 'Resume.pdf')
writeFileSync(pdf, '%PDF')
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), resumeForApplication: () => ({ id: 'res_x', pdfFile: null }), buildResumePdf: async () => ({ path: pdf }) }))
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => '- Page URL: https://jobs.example.com/thanks\n- Page Title: Thanks' }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { codesWaiting, submissions } = await import('../src/jobs/fill-form')
const { stoppedForms } = await import('../src/jobs/form-windows')
const { toolsFor } = await import('../src/mcp/tools')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication, requestSubmit, setStage } = await import('../src/services/applications')
const { answerQuestions, askQuestions, listQuestions, savePackage, scrubSecurityCodes, SPENT_CODE } = await import('../src/services/questions')
const { updateSettings } = await import('../src/settings')

const CODE = 'Xq7Lm2Pa'
const NEW_CODE = 'Hb4Tz9Wc'
const filled = { outcome: 'ready', summary: 'All filled.', filled: [{ field: 'Why us?', value: 'Because.', source: 'package' }], needsYou: [] }
const askedForCode = { outcome: 'not_submitted', summary: 'The form asked for a security code it emailed.', problems: [{ field: 'Security code', why: 'Emailed to the applicant.' }], confirmation: '', codeRequested: true }
const submitted = { outcome: 'submitted', summary: 'Thank you for applying.', problems: [], confirmation: 'Thank you for applying!' }

const app = (companyName: string) => createApplication({ companyName, role: 'Engineering Manager', stage: 'review', applyUrl: `https://jobs.example.com/${companyName}`, packageMd: '# Package\n\n### Q1 Why us?\nBecause.' })
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const run = async (id: string) => {
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, id)).run()
  await executeTask({ ...task(id), status: 'running' })
  return task(id)
}
const codeQuestion = (applicationId: string) => listQuestions({ applicationId, status: 'all' }).find((q) => q.question === 'Security code')!
const reset = () => {
  tab.calls = []
  tab.opens = 0
  ai.prompts = []
}
const tool = (name: string) => toolsFor('grokbot').find((t) => t.name === name)!

/** Submit it (as a batch would, closing windows when it's done) and stop at the form's security code. */
const stopAtCode = async (company: string) => {
  grokBotToken(true)
  updateSettings('grokBot', { submit: true })
  const a = app(company)
  ai.replies = [filled, askedForCode]
  const t = await run(requestSubmit(a.id, { closeWhenDone: true }).id)
  reset()
  return { a, t }
}

afterEach(() => {
  setSecret('grokbot-token', '')
  updateSettings('grokBot', { submit: false })
  db.delete(schema.tasks).run()
  stoppedForms.clear()
  ai.replies = []
  reset()
  tab.gone = false
})

describe('a submit that stops at a security code', () => {
  test('keeps the window open (even in a batch), asks for the code, and lists it as waiting', async () => {
    const { a, t } = await stopAtCode('Acme')
    expect(task(t.id).status).toBe('done')
    expect(getApplication(a.id)!.stage).toBe('approved')
    expect(getApplication(a.id)!.appliedAt).toBeNull()
    expect(codeQuestion(a.id)).toMatchObject({ status: 'open', about: 'application', scope: 'application' })
    expect(submissions(a.id)[0]).toMatchObject({ status: 'code' })
    const [w] = codesWaiting()
    expect(w).toMatchObject({ applicationId: a.id, questionId: codeQuestion(a.id).id, code: 'needed', windowOpen: true, markedAppliedAt: null })
    // When submit was clicked: the code to relay is the newest one emailed after it.
    expect(w!.codeRequestedAt <= task(t.id).finishedAt!).toBe(true)
    expect(JSON.parse(task(t.id).output!).codeRequestedAt).toBe(w!.codeRequestedAt)
    expect(getApplication(a.id)!.nextAction).toMatch(/security code/)
  })

  test('answered while the window is open: the code goes in there, it is submitted, and no copy is kept', async () => {
    const { a } = await stopAtCode('Globex')
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    expect(r.submits).toEqual([{ applicationId: a.id, taskId: expect.any(String), window: 'open' }])
    expect(r.resubmitted).toEqual([a.id])
    // Never in the package or a document.
    expect(getApplication(a.id)!.packageMd).not.toContain(CODE)
    expect(codesWaiting()[0]).toMatchObject({ code: 'answered', resumingTaskId: r.submits[0]!.taskId })

    ai.replies = [{ ...submitted, summary: `Entered ${CODE} and it went in.` }]
    const done = await run(r.submits[0]!.taskId!)
    expect(tab.opens).toBe(0)
    expect(tab.calls).toEqual(['guard', 'unguard', 'close'])
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain(`The code: \`${CODE}\``)
    expect(getApplication(a.id)!.stage).toBe('applied')
    expect(submissions(a.id)[0]).toMatchObject({ status: 'submitted' })
    expect(codesWaiting()).toEqual([])
    // Used: kept nowhere, not even in the task's record.
    expect(codeQuestion(a.id).answer).toBe(SPENT_CODE)
    expect(JSON.stringify(done)).not.toContain(CODE)
    expect(done.log).toContain('[security code]')
    expect(JSON.stringify(getApplication(a.id))).not.toContain(CODE)
    expect(JSON.stringify(db.select().from(schema.activity).all())).not.toContain(CODE)
  })

  test('answered after the window is gone: the form is filled again in a new window, and its new code is asked for', async () => {
    const { a } = await stopAtCode('Initech')
    // Sidedoor restarted: no window survives.
    stoppedForms.clear()
    expect(codesWaiting()[0]).toMatchObject({ windowOpen: false, code: 'needed' })
    expect(codesWaiting()[0]!.next).toMatch(/new window/)
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    expect(r.submits).toEqual([{ applicationId: a.id, taskId: expect.any(String), window: 'new' }])

    ai.replies = [filled, askedForCode]
    const done = await run(r.submits[0]!.taskId!)
    expect(tab.opens).toBe(1)
    // The old code is no use in a new form, and isn't shown to it.
    expect(ai.prompts.join('\n')).not.toContain(CODE)
    expect(JSON.stringify(done)).not.toContain(CODE)
    expect(codeQuestion(a.id)).toMatchObject({ status: 'open', answer: null })
    expect(codesWaiting()[0]).toMatchObject({ taskId: done.id, windowOpen: true, code: 'needed' })

    // The new code goes into that window.
    reset()
    const again = answerQuestions([{ id: codeQuestion(a.id).id, answer: NEW_CODE }], 'grokbot')
    expect(again.submits[0]).toMatchObject({ window: 'open' })
    ai.replies = [submitted]
    await run(again.submits[0]!.taskId!)
    expect(ai.prompts[0]).toContain(NEW_CODE)
    expect(getApplication(a.id)!.stage).toBe('applied')
  })

  test('an expired code: the form sends a new one, the window stays, and the newest code is asked for', async () => {
    const { a } = await stopAtCode('Hooli')
    const before = codesWaiting()[0]!.codeRequestedAt
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    ai.replies = [{ outcome: 'code_rejected', summary: 'The code has expired. Clicked "Resend code".', problems: [], confirmation: '', newCodeSent: true }]
    const done = await run(r.submits[0]!.taskId!)
    expect(tab.calls).toEqual(['guard', 'unguard', `finish: ${'Sidedoor is waiting for the security code this form emailed you. Answer "Security code" in Sidedoor and it enters the code here and finishes submitting, or enter it yourself.'}`])
    expect(getApplication(a.id)!.stage).toBe('approved')
    expect(done.input.submitStartedAt).toBeUndefined()
    expect(JSON.stringify(done)).not.toContain(CODE)
    expect(codeQuestion(a.id)).toMatchObject({ status: 'open', answer: null })
    expect(codeQuestion(a.id).why).toMatch(/emailed a new one/)
    expect(submissions(a.id)[0]).toMatchObject({ status: 'code' })
    const w = codesWaiting()[0]!
    expect(w).toMatchObject({ taskId: done.id, windowOpen: true, code: 'needed' })
    expect(w.codeRequestedAt > before).toBe(true)

    reset()
    const again = answerQuestions([{ id: codeQuestion(a.id).id, answer: NEW_CODE }], 'grokbot')
    ai.replies = [submitted]
    await run(again.submits[0]!.taskId!)
    expect(tab.opens).toBe(0)
    expect(getApplication(a.id)!.stage).toBe('applied')
  })

  test('already submitted: answering the code again says so and sends nothing', async () => {
    const { a } = await stopAtCode('Umbrella')
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    ai.replies = [submitted]
    await run(r.submits[0]!.taskId!)
    const late = answerQuestions([{ id: codeQuestion(a.id).id, answer: NEW_CODE }], 'grokbot')
    expect(late.resubmitted).toEqual([])
    expect(late.submits).toEqual([{ applicationId: a.id, reason: expect.stringMatching(/Already submitted/) }])
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued')).all()).toEqual([])
  })

  test('marked Applied by hand after it stopped: listed, reported, and not sent again until moved back', async () => {
    const { a } = await stopAtCode('Stark')
    // An agent can't call it Applied while the code is outstanding, unless it says how it knows.
    const refused = await tool('update_application').handler({ id: a.id, stage: 'applied' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toMatch(/security code/)
    expect(getApplication(a.id)!.stage).toBe('approved')
    // The user's own "I submitted it".
    setStage(a.id, 'applied')
    expect(submissions(a.id)[0]).toMatchObject({ status: 'marked_applied' })
    expect(codesWaiting()[0]).toMatchObject({ applicationId: a.id, markedAppliedAt: getApplication(a.id)!.appliedAt })
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    expect(r.submits).toEqual([{ applicationId: a.id, reason: expect.stringMatching(/by hand.*never saw a confirmation/) }])
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.status, 'queued')).all()).toEqual([])
    // It didn't go in: moved back, it can be sent again.
    setStage(a.id, 'approved')
    expect(getApplication(a.id)!.appliedAt).toBeNull()
    expect(requestSubmit(a.id).status).toBe('queued')
  })

  test('an agent may mark it applied with evidence, which is kept in the notes', async () => {
    const { a } = await stopAtCode('Wonka')
    const ok = await tool('update_application').handler({ id: a.id, stage: 'applied', appliedEvidence: 'Confirmation email from Wonka at 9:02' })
    expect(ok.isError).toBeFalsy()
    expect(getApplication(a.id)!.notesMd).toMatch(/Marked applied without Sidedoor seeing it go in: Confirmation email from Wonka/)
  })

  test('security_codes_waiting lists them for the relay', async () => {
    const { a } = await stopAtCode('Soylent')
    const r = await tool('security_codes_waiting').handler({})
    const body = JSON.parse(r.content[0]!.text) as { waiting: { applicationId: string; windowOpen: boolean }[] }
    expect(body.waiting).toEqual([expect.objectContaining({ applicationId: a.id, windowOpen: true })])
  })
})

describe('security code questions', () => {
  test('are only ever about one application, and never answered from another', () => {
    const a = app('One')
    const b = app('Two')
    const [qa] = askQuestions(a.id, 'fill', [{ question: 'Security code', about: 'you', saveTo: 'answers' }])
    expect(qa).toMatchObject({ status: 'open' })
    answerQuestions([{ id: qa!.id, answer: CODE, allApplications: true }], 'grokbot')
    const [qb] = askQuestions(b.id, 'fill', [{ question: 'Security code' }])
    expect(qb).toMatchObject({ status: 'open', known: false, answer: null })
    expect(codeQuestion(a.id)).toMatchObject({ scope: 'application', saveTo: null })
  })

  test('on start, codes are taken out of packages and old answers are not kept', () => {
    const a = app('Older')
    const [q] = askQuestions(a.id, 'fill', [{ question: 'Security code' }])
    // How it was before: the answer went into the package.
    savePackage(a.id, `${getApplication(a.id)!.packageMd}\n\n## Your answers to questions\n\n### Security code\n${CODE}\n`)
    answerQuestions([{ id: q!.id, answer: CODE }], 'grokbot', { continueSubmit: false })
    expect(getApplication(a.id)!.packageMd).toContain(CODE)
    expect(scrubSecurityCodes()).toBeGreaterThan(0)
    expect(getApplication(a.id)!.packageMd).not.toContain(CODE)
    expect(getApplication(a.id)!.packageMd).toContain('Because.')
    expect(codeQuestion(a.id).answer).toBe(SPENT_CODE)
  })
})
