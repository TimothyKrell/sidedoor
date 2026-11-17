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

// The Grok Bot routine webhook: every POST Sidedoor makes, and how it answers.
const hook = vi.hoisted(() => ({ calls: [] as { url: string; headers: Record<string, string>; body: Record<string, unknown> }[], status: 200, down: false }))
vi.stubGlobal('fetch', async (url: string, init: { headers: Record<string, string>; body: string }) => {
  if (hook.down) throw new TypeError('fetch failed')
  hook.calls.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> })
  return new Response('{}', { status: hook.status })
})

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { codesWaiting, submissions } = await import('../src/jobs/fill-form')
const { stoppedForms } = await import('../src/jobs/form-windows')
const { toolsFor } = await import('../src/mcp/tools')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication, requestSubmit, setStage } = await import('../src/services/applications')
const { nowIso } = await import('../src/ids')
const { answerQuestions, askQuestions, listQuestions, savePackage, scrubSecurityCodes, SPENT_CODE } = await import('../src/services/questions')
const { updateSettings } = await import('../src/settings')
const { announceCode, CODE_WAIT_MS } = await import('../src/jobs/code-relay')

const HOOK = 'https://routines.example.com/hooks/abc'
const KEY = 'whk_test_key'
const setHook = (o: { url?: string; key?: string; codeUrl?: string; codeKey?: string } = { url: HOOK, key: KEY }) => {
  updateSettings('grokBot', { webhookUrl: o.url ?? '', codeWebhookUrl: o.codeUrl ?? '' })
  setSecret('grokbot-webhook-key', o.key ?? '')
  setSecret('grokbot-code-webhook-key', o.codeKey ?? '')
}

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
  setHook({})
  hook.calls = []
  hook.status = 200
  hook.down = false
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

describe('telling Grok Bot a code is waiting', () => {
  test('without a webhook nothing is sent: the question just waits, as before', async () => {
    const { a, t } = await stopAtCode('Quiet')
    expect(hook.calls).toEqual([])
    expect(codeQuestion(a.id).status).toBe('open')
    expect(task(t.id).log).toContain('No security code webhook set: the question waits in Sidedoor')
    expect(codesWaiting()[0]).toMatchObject({ grokBotTold: false, windowOpen: true })
  })

  test('a code prompt POSTs once to the routine, with no personal details and no code', async () => {
    setHook()
    const { a, t } = await stopAtCode('Greenhouse Co')
    expect(hook.calls).toHaveLength(1)
    const [c] = hook.calls
    expect(c!.url).toBe(HOOK)
    expect(c!.headers.authorization).toBe(`Bearer ${KEY}`)
    const w = codesWaiting()[0]!
    expect(c!.body).toEqual({
      sidedoor: 'security-code',
      appId: a.id,
      company: 'Greenhouse Co',
      role: 'Engineering Manager',
      questionId: codeQuestion(a.id).id,
      requestedAt: w.codeRequestedAt,
      ats: 'unknown',
      waitUntil: new Date(Date.parse(w.codeRequestedAt) + CODE_WAIT_MS).toISOString(),
    })
    // The window waits at least 15 minutes for it.
    expect(Date.parse(w.waitUntil) - Date.parse(w.codeRequestedAt)).toBeGreaterThanOrEqual(15 * 60_000)
    expect(w).toMatchObject({ grokBotTold: true, resendsLeft: 2 })
    expect(JSON.stringify(c!.body)).not.toMatch(/@|\+1|resume/i)
    expect(task(t.id).log).toContain('Told Grok Bot the form is waiting on a security code')
    // The key never lands in the task's record or the activity.
    expect(JSON.stringify(task(t.id))).not.toContain(KEY)
    expect(JSON.stringify(db.select().from(schema.activity).all())).not.toContain(KEY)

    // Grok Bot answers: the code goes into the window left open, and nothing is POSTed again.
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    expect(r.submits[0]).toMatchObject({ window: 'open' })
    ai.replies = [submitted]
    await run(r.submits[0]!.taskId!)
    expect(getApplication(a.id)!.stage).toBe('applied')
    expect(hook.calls).toHaveLength(1)
  })

  test('the ATS is named from the form, e.g. Greenhouse behind a company careers page', () => {
    setHook()
    const a = createApplication({ companyName: 'Payco', role: 'EM', stage: 'approved', applyUrl: 'https://payco.example.com/jobs/search?gh_jid=123', packageMd: '# P' })
    return announceCode(a, { questionId: 'q_1', requestedAt: '2026-11-17T12:00:00.000Z' }).then((r) => {
      expect(r).toBe('sent')
      expect(hook.calls[0]!.body.ats).toBe('greenhouse')
    })
  })

  test('debounced: one request per code prompt, even asked twice at once', async () => {
    setHook()
    const a = app('Twice')
    const o = { questionId: 'q_x', requestedAt: '2026-11-17T12:00:00.000Z' }
    expect(await Promise.all([announceCode(a, o), announceCode(a, o)])).toEqual(['sent', 'duplicate'])
    expect(await announceCode(a, o)).toBe('duplicate')
    expect(hook.calls).toHaveLength(1)
    // A new prompt (a new code) is a new request.
    expect(await announceCode(a, { ...o, requestedAt: '2026-11-17T12:20:00.000Z' })).toBe('sent')
    expect(hook.calls).toHaveLength(2)
  })

  test("a webhook that fails isn't retried, doesn't fail the submit, and doesn't say where it points", async () => {
    setHook()
    hook.down = true
    const { a, t } = await stopAtCode('Offline')
    expect(task(t.id).status).toBe('done')
    expect(codeQuestion(a.id).status).toBe('open')
    expect(task(t.id).log).toContain("Couldn't reach the security code webhook: the question waits in Sidedoor")
    hook.down = false
    expect(await announceCode(getApplication(a.id)!, { questionId: codeQuestion(a.id).id, requestedAt: codesWaiting()[0]!.codeRequestedAt })).toBe('duplicate')
    expect(JSON.stringify(db.select().from(schema.activity).all())).not.toContain('routines.example.com')
  })

  test('the security code routine, when set, is called instead of the task routine, with its own key', async () => {
    setHook({ url: HOOK, key: KEY, codeUrl: 'https://routines.example.com/hooks/codes', codeKey: 'whk_codes' })
    await stopAtCode('Own')
    expect(hook.calls.map((c) => [c.url, c.headers.authorization])).toEqual([['https://routines.example.com/hooks/codes', 'Bearer whk_codes']])
    // Its URL without its key is not configured: the task routine's key never goes to another URL.
    hook.calls = []
    setHook({ url: HOOK, key: KEY, codeUrl: 'https://routines.example.com/hooks/codes' })
    expect(await announceCode(app('NoKey'), { questionId: 'q', requestedAt: nowIso() })).toBe('not_configured')
    expect(hook.calls).toEqual([])
  })

  test('an expired code asks for a new one and tells Grok Bot again, at most twice per application', async () => {
    setHook()
    const { a } = await stopAtCode('Expiry')
    expect(hook.calls).toHaveLength(1)
    const rejected = { outcome: 'code_rejected', summary: 'The code expired. Clicked "Resend code".', problems: [], confirmation: '', newCodeSent: true }
    for (const n of [2, 3]) {
      reset()
      const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
      ai.replies = [rejected]
      await run(r.submits[0]!.taskId!)
      expect(ai.prompts[0]).toContain('click that once and set `newCodeSent`')
      expect(hook.calls).toHaveLength(n)
      expect(hook.calls[n - 1]!.body.requestedAt).toBe(codesWaiting()[0]!.codeRequestedAt)
    }
    expect(codesWaiting()[0]).toMatchObject({ resendsLeft: 0 })
    // Two new codes asked for: the third rejection asks for none, and Grok Bot isn't called again.
    reset()
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    ai.replies = [{ ...rejected, summary: 'The code expired.', newCodeSent: false }]
    await run(r.submits[0]!.taskId!)
    expect(ai.prompts[0]).toContain("Don't ask it for a new code")
    expect(hook.calls).toHaveLength(3)
    expect(getApplication(a.id)!.nextAction).toMatch(/finish it in the Sidedoor window/)
    expect(codeQuestion(a.id).status).toBe('open')
  })

  test('after the window is gone, the answer starts a fresh submit, whose new code prompt is announced', async () => {
    setHook()
    const { a } = await stopAtCode('Restarted')
    stoppedForms.clear()
    const r = answerQuestions([{ id: codeQuestion(a.id).id, answer: CODE }], 'grokbot')
    expect(r.submits[0]).toMatchObject({ window: 'new' })
    ai.replies = [filled, askedForCode]
    await run(r.submits[0]!.taskId!)
    expect(tab.opens).toBe(1)
    expect(hook.calls).toHaveLength(2)
    expect(hook.calls[1]!.body.requestedAt).not.toBe(hook.calls[0]!.body.requestedAt)
    expect(JSON.stringify(hook.calls)).not.toContain(CODE)
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
