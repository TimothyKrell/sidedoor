import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'

// The AI's answers, in order; and whether the resume was in the upload folder when the fill ran.
const ai = vi.hoisted(() => ({ replies: [] as unknown[], prompts: [] as string[], uploads: [] as boolean[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    const path = o.prompt.match(/\/[^\s`]*\/fill-[^\s/`]+\/[^\s`]+\.pdf/)?.[0]
    if (path) ai.uploads.push(existsSync(path))
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
const SNAP = '### Page\n- Page URL: https://jobs.example.com/thanks\n- Page Title: Application received\n### Snapshot\n```yaml\n- heading "Thank you for applying!" [level=1]\n```'
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => SNAP }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))

// Resumes, without rendering: each id's row, and what building its PDF writes.
const dir = mkdtempSync(join(tmpdir(), 'sd-batch-'))
const res = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), builds: [] as string[], buildWrites: '%PDF-1.7 tailored' }))
vi.mock('../src/services/resumes', async (orig) => ({
  ...(await orig<typeof import('../src/services/resumes')>()),
  getResume: (id: string) => res.rows.get(id),
  resumeForApplication: (a: { resumeId: string | null }) => (a.resumeId ? res.rows.get(a.resumeId) : undefined) ?? res.rows.get('res_base'),
  buildResumePdf: async (id: string) => {
    res.builds.push(id)
    const path = join(dir, `${id}.pdf`)
    writeFileSync(path, res.buildWrites)
    return { file: `${id}.pdf`, pages: 1, path }
  },
}))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { resumePdfFor } = await import('../src/jobs/fill-form')
const { applyLinkIn, resolveApplyTarget } = await import('../src/jobs/apply-url')
const batch = await import('../src/jobs/submit-batch')
const { serverInstructions, toolsFor } = await import('../src/mcp/tools')
const { mcpProfileFor } = await import('../src/http/auth')
const { mcpFor } = await import('../src/ai')
const { agentToken, connectedToken } = await import('../src/secrets')
const { askQuestions } = await import('../src/services/questions')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication } = await import('../src/services/applications')
const { setMeta, updateSettings } = await import('../src/settings')

const allow = (submit = true) => {
  grokBotToken(true)
  updateSettings('grokBot', { submit })
}
const resume = (id: string, o: Record<string, unknown> = {}) => res.rows.set(id, { id, title: `Resume ${id}`, pdfFile: null, pdfAt: null, updatedAt: '2026-10-01T00:00:00.000Z', ...o })
let n = 0
const app = (companyName: string, o: Partial<typeof schema.applications.$inferInsert> = {}) => {
  const rid = `res_${++n}`
  resume(rid)
  return createApplication({ companyName, role: `Role ${n}`, stage: 'approved', applyUrl: `https://boards.greenhouse.io/${companyName.toLowerCase()}/jobs/${n}`, packageMd: '# Package', resumeId: rid, ...o })
}
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const run = async (id: string) => {
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, id)).run()
  await executeTask({ ...task(id), status: 'running' })
  return task(id)
}
// Job pages are never fetched in tests: the batch reads them through this.
const noFetch = (t: { applyUrl: string | null; jobUrl: string | null }) => resolveApplyTarget(t, async () => '<html></html>')
const advance = () => batch.advanceBatches(noFetch)
const report = () => batch.batchReport()!
const itemOf = (id: string) => report().items.find((i) => i.applicationId === id)!
const filled = { outcome: 'ready', summary: 'All filled.', filled: [], needsYou: [] }

afterEach(() => {
  for (const b of batch.listBatches()) if (b.status === 'running' || b.status === 'paused') batch.cancelBatch(b.id)
  setSecret('grokbot-token', '')
  updateSettings('grokBot', { submit: false, companyLimits: [] })
  updateSettings('agents', { submit: false })
  db.delete(schema.tasks).run()
  db.delete(schema.questions).run()
  db.delete(schema.applications).run()
  ai.replies = []
  ai.prompts = []
  ai.uploads = []
  tab.calls = []
  res.builds = []
  res.buildWrites = '%PDF-1.7 tailored'
})

describe('queue order', () => {
  const rows = [
    { id: 'a', priority: 'low' as const, rank: null, fitScore: 90, shot: 10, createdAt: '2026-01-01', postedAt: '2026-10-01' },
    { id: 'b', priority: 'high' as const, rank: 2, fitScore: 70, shot: 50, createdAt: '2026-01-02', postedAt: '2026-10-20' },
    { id: 'c', priority: 'high' as const, rank: 1, fitScore: 60, shot: 60, createdAt: '2026-01-03', postedAt: null },
    { id: 'd', priority: 'medium' as const, rank: null, fitScore: 90, shot: 40, createdAt: '2026-01-04', postedAt: '2026-10-25' },
  ]
  const ids = (o: Parameters<typeof batch.orderApplications>[1]) => batch.orderApplications(rows, o).map((r) => r.id)

  test('by priority: high first, then rank, then fit', () => expect(ids('priority')).toEqual(['c', 'b', 'd', 'a']))
  test('by score: fit, then chance of an interview', () => expect(ids('score')).toEqual(['d', 'a', 'b', 'c']))
  test('by posting date: newest listing first, undated last', () => expect(ids('posted')).toEqual(['d', 'b', 'a', 'c']))
  test('given: as listed', () => expect(ids('given')).toEqual(['a', 'b', 'c', 'd']))

  test('a filter takes the approved ones by priority; a list of ids keeps its order', () => {
    allow()
    const low = app('Low', { priority: 'low' })
    const high = app('High', { priority: 'high' })
    app('Reviewing', { stage: 'review' })
    expect(batch.startBatch({ mode: 'dry-run' }).items.map((i) => i.applicationId)).toEqual([high.id, low.id])
    batch.cancelBatch(batch.getBatch()!.id)
    expect(batch.startBatch({ mode: 'dry-run', applicationIds: [low.id, high.id] }).items.map((i) => i.applicationId)).toEqual([low.id, high.id])
  })
})

describe('company limits', () => {
  test('names compare loosely, and * is the default', () => {
    const limits = [
      { company: 'Bankly', max: 3, days: 60 },
      { company: '*', max: 5, days: 30 },
    ]
    expect(batch.limitFor('Bankly, Inc.', limits)).toMatchObject({ max: 3 })
    expect(batch.limitFor('Auditly', limits)).toMatchObject({ max: 5 })
    expect(batch.limitFor('Auditly', [])).toBeNull()
  })

  test('counted from what went in within the window, skipped and reported when it would go over', async () => {
    allow()
    updateSettings('grokBot', { companyLimits: [{ company: 'Bankly', max: 2, days: 60 }] })
    const day = 86_400_000
    app('Bankly', { stage: 'applied', appliedAt: new Date(Date.now() - 10 * day).toISOString() })
    app('Bankly', { stage: 'applied', appliedAt: new Date(Date.now() - 90 * day).toISOString() }) // outside the window
    const one = app('Bankly')
    const two = app('Bankly')
    batch.startBatch({ mode: 'submit', applicationIds: [one.id, two.id], allowSameCompany: true })
    await advance()
    expect(itemOf(one.id).status).toBe('queued')
    await run(itemOf(one.id).taskId!) // the fill asks a question: it may still go in, so it counts
    ai.replies = []
    await advance()
    expect(itemOf(two.id)).toMatchObject({ status: 'blocked', blockedBy: 'limit' })
    expect(itemOf(two.id).summary).toMatch(/Bankly limit: 2 per 60 days, and 2 went in already \(1 in this batch\)/)
    expect(report().status).toBe('done')
  })

  test("a batch's own limits come first", async () => {
    allow()
    app('Auditly', { stage: 'applied', appliedAt: new Date().toISOString() })
    const b = app('Auditly')
    batch.startBatch({ mode: 'dry-run', applicationIds: [b.id], limits: [{ company: 'auditly', max: 1, days: 60 }] })
    await advance()
    expect(itemOf(b.id)).toMatchObject({ status: 'blocked', blockedBy: 'limit' })
  })

  test('two roles at one company: only the first goes, unless the batch allows it', async () => {
    allow()
    const first = app('Acme')
    const second = app('Acme')
    batch.startBatch({ mode: 'dry-run', applicationIds: [first.id, second.id] })
    await advance()
    ai.replies = [filled]
    await run(itemOf(first.id).taskId!)
    await advance()
    expect(itemOf(second.id)).toMatchObject({ status: 'blocked', blockedBy: 'limit' })
    expect(itemOf(second.id).summary).toContain('one role per company')
  })
})

describe('modes', () => {
  test('dry run: one form at a time, each reported, closed after, and nothing submitted', async () => {
    allow()
    const a = app('Globex')
    const b = app('Initech')
    batch.startBatch({ mode: 'dry-run', applicationIds: [a.id, b.id] })
    await advance()
    expect(itemOf(a.id).status).toBe('queued')
    expect(itemOf(b.id).status).toBe('pending')
    // Its turn doesn't come while the first is still waiting or filling.
    await advance()
    expect(itemOf(b.id).status).toBe('pending')
    ai.replies = [filled]
    await run(itemOf(a.id).taskId!)
    expect(tab.calls).toEqual(['close'])
    expect(itemOf(a.id).status).toBe('ready')
    await advance()
    expect(itemOf(b.id).status).toBe('queued')
    ai.replies = [{ outcome: 'needs_you', summary: 'One question.', filled: [], needsYou: [{ field: 'Start date', why: 'not in the package', options: [] }] }]
    await run(itemOf(b.id).taskId!)
    await advance()
    const r = report()
    expect(r.status).toBe('done')
    expect(r.counts).toEqual({ ready: 1, questions: 1 })
    expect(itemOf(b.id).questions).toEqual([{ question: 'Start date', why: 'not in the package', options: [] }])
    expect(ai.prompts).toHaveLength(2) // no submit step ran
    expect(getApplication(a.id)!.appliedAt).toBeNull()
  })

  test('fill only: filled and left open for the user, never sent to be submitted', async () => {
    allow()
    const a = app('Hooli')
    batch.startBatch({ mode: 'fill', applicationIds: [a.id] })
    await advance()
    const t = task(itemOf(a.id).taskId!)
    expect(t.input.submit).toBeUndefined()
    ai.replies = [filled]
    await run(t.id)
    expect(tab.calls).toEqual(['finish'])
    expect(ai.prompts[0]).not.toContain('This one gets submitted')
    expect(itemOf(a.id).status).toBe('filled')
    expect(getApplication(a.id)!.stage).toBe('approved')
  })

  test('fill only never turns into a submit already waiting for the same application', async () => {
    allow()
    const a = app('Waiting')
    const { requestSubmit } = await import('../src/services/applications')
    requestSubmit(a.id)
    batch.startBatch({ mode: 'fill', applicationIds: [a.id] })
    await advance()
    expect(itemOf(a.id)).toMatchObject({ status: 'failed' })
    expect(itemOf(a.id).summary).toMatch(/already sent to be submitted/)
  })

  test('submit: filled, submitted once, with the evidence in the report', async () => {
    allow()
    const a = app('Wayne', { stage: 'review' })
    batch.startBatch({ mode: 'submit', applicationIds: [a.id] })
    await advance()
    expect(getApplication(a.id)!.stage).toBe('approved')
    ai.replies = [filled, { outcome: 'submitted', summary: 'Thanks for applying.', problems: [], confirmation: 'Thank you for applying!' }]
    await run(itemOf(a.id).taskId!)
    await advance()
    expect(itemOf(a.id)).toMatchObject({ status: 'submitted', evidence: { url: 'https://jobs.example.com/thanks', reported: 'Thank you for applying!' } })
    expect(getApplication(a.id)!.stage).toBe('applied')
    expect(report().status).toBe('done')
  })

  test('a submit batch needs the user to let Grok Bot submit, and pauses when that is turned off', async () => {
    const a = app('Stark')
    const b = app('Oscorp')
    expect(() => batch.startBatch({ mode: 'submit', applicationIds: [a.id] })).toThrow(/turned off/)
    allow()
    batch.startBatch({ mode: 'submit', applicationIds: [a.id, b.id] })
    updateSettings('grokBot', { submit: false })
    await advance()
    expect(report().status).toBe('paused')
    expect(report().note).toMatch(/turned off/)
    expect(itemOf(a.id).status).toBe('pending')
  })

  test('blocked by a sign-in or captcha is reported as such', async () => {
    allow()
    const a = app('Cyberdyne')
    batch.startBatch({ mode: 'dry-run', applicationIds: [a.id] })
    await advance()
    ai.replies = [{ outcome: 'blocked', summary: 'The form needs you to sign in to a Workday account first.', filled: [], needsYou: [] }]
    await run(itemOf(a.id).taskId!)
    expect(itemOf(a.id)).toMatchObject({ status: 'blocked', blockedBy: 'login' })
    expect(batch.blockedByOf('A reCAPTCHA appeared')).toBe('captcha')
  })

  test('rule checks stop it before a form opens', async () => {
    allow()
    const done = app('Done', { stage: 'applied', appliedAt: '2026-10-01T00:00:00Z' })
    const noPkg = app('NoPkg', { packageMd: null })
    batch.startBatch({ mode: 'dry-run', applicationIds: [done.id, noPkg.id] })
    await advance()
    expect(itemOf(done.id)).toMatchObject({ status: 'blocked', blockedBy: 'rule' })
    expect(itemOf(noPkg.id)).toMatchObject({ status: 'blocked', blockedBy: 'rule' })
    expect(db.select().from(schema.tasks).all()).toHaveLength(0)
  })
})

describe('pause, resume, cancel', () => {
  test('pausing holds back the queued form; resuming sends it; cancelling stops the rest', async () => {
    allow()
    const a = app('One')
    const b = app('Two')
    const c = app('Three')
    const { id } = batch.startBatch({ mode: 'dry-run', applicationIds: [a.id, b.id, c.id] })
    await advance()
    const first = itemOf(a.id).taskId!
    batch.pauseBatch(id, true)
    expect(task(first).status).toBe('cancelled')
    expect(itemOf(a.id).status).toBe('pending')
    await advance()
    expect(itemOf(a.id).status).toBe('pending')
    batch.pauseBatch(id, false)
    await advance()
    expect(itemOf(a.id).status).toBe('queued')
    ai.replies = [filled]
    await run(itemOf(a.id).taskId!)
    await advance()
    expect(itemOf(b.id).status).toBe('queued')
    batch.cancelBatch(id)
    expect(report().status).toBe('cancelled')
    // Its form was still waiting: held back, so it never opens.
    expect(itemOf(b.id).status).toBe('cancelled')
    expect(task(db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, b.id)).get()!.id).status).toBe('cancelled')
    expect(itemOf(c.id).status).toBe('cancelled')
    expect(itemOf(a.id).status).toBe('ready')
  })

  test('one batch at a time', () => {
    allow()
    const a = app('Solo')
    batch.startBatch({ mode: 'dry-run', applicationIds: [a.id] })
    expect(() => batch.startBatch({ mode: 'dry-run', applicationIds: [a.id] })).toThrow(/Cancel it/)
  })
})

describe('the resume PDF', () => {
  test('a missing tailored resume stops the batch item with what to do', async () => {
    allow()
    const gone = app('Gone')
    res.rows.delete(gone.resumeId!)
    const base = app('Base', { resumeId: null })
    batch.startBatch({ mode: 'dry-run', applicationIds: [gone.id, base.id] })
    await advance()
    expect(itemOf(gone.id).summary).toMatch(/tailored resume was deleted/)
    expect(itemOf(base.id).summary).toMatch(/No tailored resume/)
    await expect(resumePdfFor({ resumeId: gone.resumeId, companyName: 'Gone' })).rejects.toThrow(/Tailor one again/)
  })

  test('built when missing or stale, kept when fresh, and a failed build fails clearly', async () => {
    resume('res_fresh', { pdfFile: join(dir, 'fresh.pdf'), pdfAt: '2026-10-02T00:00:00.000Z' })
    writeFileSync(join(dir, 'fresh.pdf'), '%PDF-1.7 fresh')
    expect((await resumePdfFor({ resumeId: 'res_fresh', companyName: 'X' })).path).toBe(join(dir, 'fresh.pdf'))
    expect(res.builds).toEqual([])
    resume('res_stale', { pdfFile: join(dir, 'fresh.pdf'), pdfAt: '2026-09-01T00:00:00.000Z' })
    await resumePdfFor({ resumeId: 'res_stale', companyName: 'X' })
    resume('res_lost', { pdfFile: join(dir, 'nowhere.pdf'), pdfAt: '2026-10-02T00:00:00.000Z' })
    await resumePdfFor({ resumeId: 'res_lost', companyName: 'X' })
    expect(res.builds).toEqual(['res_stale', 'res_lost'])
    res.buildWrites = ''
    resume('res_broken')
    await expect(resumePdfFor({ resumeId: 'res_broken', companyName: 'X' })).rejects.toThrow(/Couldn't make the PDF/)
  })

  test("it is in the fill's upload folder when the form is filled", async () => {
    allow()
    const a = app('Upload')
    batch.startBatch({ mode: 'dry-run', applicationIds: [a.id] })
    await advance()
    ai.replies = [filled]
    await run(itemOf(a.id).taskId!)
    expect(ai.uploads).toEqual([true])
  })
})

describe('apply URL', () => {
  const page = 'https://www.acme.example/careers/staff-engineer'
  test('an ATS apply link on the job page', () => {
    const html = `<a href="/about">About</a><a class="btn" href="https://jobs.lever.co/acme/1b2c3d4e-0000-4000-8000-000000000000/apply">Apply for this job</a>`
    expect(applyLinkIn(html, page)).toEqual({ kind: 'form', url: 'https://jobs.lever.co/acme/1b2c3d4e-0000-4000-8000-000000000000/apply', resolved: true })
  })
  test('a careers page that embeds Greenhouse', () => {
    const html = `<div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>`
    expect(applyLinkIn(html, `${page}?gh_jid=4012345`)).toEqual({ kind: 'form', url: 'https://job-boards.greenhouse.io/acme/jobs/4012345', resolved: true })
  })
  test('an Apply button to another site, relative links resolved', () => {
    expect(applyLinkIn('<a href="/apply/staff-engineer?src=site">Apply now</a>', page)).toMatchObject({ url: 'https://www.acme.example/apply/staff-engineer?src=site' })
  })
  test('an ATS job link only in the page data', () => {
    const html = `<script>window.__DATA__={"applyUrl":"https://jobs.ashbyhq.com/acme/5f1e2d3c-1111-4222-8333-444455556666"}</script>`
    expect(applyLinkIn(html, page)).toMatchObject({ url: 'https://jobs.ashbyhq.com/acme/5f1e2d3c-1111-4222-8333-444455556666' })
  })
  test('a mailto apply link is an email application', () => {
    expect(applyLinkIn('<p>Send your resume to <a href="mailto:jobs@acme.example?subject=Staff">jobs@acme.example</a></p>', page)).toEqual({ kind: 'email', email: 'jobs@acme.example', url: 'mailto:jobs@acme.example?subject=Staff' })
  })
  test('no apply link at all', () => expect(applyLinkIn('<a href="/team">Team</a>', page)).toBeNull())

  test('what to fill, from what the application has', async () => {
    const html = async () => '<a href="https://boards.greenhouse.io/acme/jobs/77?gh_src=x">Apply</a>'
    const fails = async () => {
      throw new Error('HTTP 403')
    }
    expect(await resolveApplyTarget({ applyUrl: null, jobUrl: 'https://jobs.lever.co/acme/abc' }, fails)).toEqual({ kind: 'form', url: 'https://jobs.lever.co/acme/abc', resolved: false })
    expect(await resolveApplyTarget({ applyUrl: 'mailto:hr@acme.example', jobUrl: page }, fails)).toMatchObject({ kind: 'email', email: 'hr@acme.example' })
    expect(await resolveApplyTarget({ applyUrl: page, jobUrl: page }, html)).toEqual({ kind: 'form', url: 'https://boards.greenhouse.io/acme/jobs/77?gh_src=x', resolved: true })
    expect(await resolveApplyTarget({ applyUrl: null, jobUrl: page }, fails)).toEqual({ kind: 'form', url: page, resolved: false })
    expect(await resolveApplyTarget({ applyUrl: null, jobUrl: null }, fails)).toMatchObject({ kind: 'none' })
  })

  test('in a batch: a found link is saved, and an email application is reported, not filled', async () => {
    allow()
    const page2 = 'https://www.initech.example/jobs/1'
    const found = app('Initech', { applyUrl: null, jobUrl: page2 })
    const mail = app('Mailco', { applyUrl: null, jobUrl: 'https://www.mailco.example/jobs/2' })
    batch.startBatch({ mode: 'dry-run', applicationIds: [mail.id, found.id] })
    const pages: Record<string, string> = {
      [page2]: '<a href="https://boards.greenhouse.io/initech/jobs/9">Apply</a>',
      'https://www.mailco.example/jobs/2': '<a href="mailto:careers@mailco.example">Apply by email</a>',
    }
    // assertPublicUrl would look these made-up hosts up; the batch takes the resolver it's given.
    await batch.advanceBatches(async (t) => {
      const url = t.applyUrl ?? t.jobUrl!
      return applyLinkIn(pages[url] ?? '', url) ?? { kind: 'form', url, resolved: false }
    })
    expect(itemOf(mail.id)).toMatchObject({ status: 'blocked', blockedBy: 'email' })
    expect(getApplication(mail.id)!.applyUrl).toBe('mailto:careers@mailco.example')
    expect(getApplication(mail.id)!.nextAction).toMatch(/Apply by email to careers@mailco.example/)
    expect(itemOf(found.id)).toMatchObject({ status: 'queued', note: 'Apply link found on the job page: https://boards.greenhouse.io/initech/jobs/9' })
    expect(getApplication(found.id)!.applyUrl).toBe('https://boards.greenhouse.io/initech/jobs/9')
  })
})

describe('MCP', () => {
  test('Grok Bot gets the batch tools only while it may submit', () => {
    grokBotToken(true)
    const names = () => toolsFor('grokbot').map((t) => t.name)
    expect(names()).not.toContain('start_submit_batch')
    allow()
    expect(names()).toEqual(expect.arrayContaining(['start_submit_batch', 'submit_batch_status', 'pause_submit_batch', 'cancel_submit_batch']))
    expect(toolsFor('app').map((t) => t.name)).not.toContain('start_submit_batch')
  })

  test('start, status and cancel through the tools', async () => {
    allow()
    const a = app('Tooled')
    const tools = new Map(toolsFor('grokbot').map((t) => [t.name, t]))
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse((await tools.get(name)!.handler(args)).content[0]!.text) as import('../src/jobs/submit-batch').BatchReport
    const started = await call('start_submit_batch', { mode: 'dry-run', applicationIds: [a.id] })
    expect(started).toMatchObject({ mode: 'dry-run', status: 'running', items: [{ applicationId: a.id }] })
    expect((await call('submit_batch_status', {})).id).toBe(started.id)
    expect((await call('cancel_submit_batch', { batchId: started.id })).status).toBe('cancelled')
  })
})

describe('your AI submits when you ask it to', () => {
  const on = (submit = true) => updateSettings('agents', { submit })
  const SUBMIT = ['submit_application', 'start_submit_batch', 'answer_questions', 'settle_decisions']
  const names = (p: Parameters<typeof toolsFor>[0]) => toolsFor(p).map((t) => t.name)
  const call = async (name: string, args: Record<string, unknown>) => (await toolsFor('connected').find((t) => t.name === name)!.handler(args)).content[0]!.text
  const ESSAY = '# Package\n\n## Cover letter\n\nDear team, I would like to work with you.\n'

  test('only the AI you talk to gets the tools, and only while you let it', () => {
    expect(names('connected')).not.toEqual(expect.arrayContaining(SUBMIT.slice(0, 1)))
    expect(serverInstructions('connected')).not.toContain('start_submit_batch')
    on()
    expect(names('connected')).toEqual(expect.arrayContaining(SUBMIT))
    expect(serverInstructions('connected')).toContain('start_submit_batch')
    for (const p of ['app', 'story', 'lookup'] as const) for (const t of SUBMIT) expect(names(p)).not.toContain(t)
    expect(names('grokbot')).not.toContain('submit_application')
  })

  test('background jobs can never reach them: their token gets the plain tools, whatever the path', () => {
    expect(mcpProfileFor('agent', '/mcp')).toBe('app')
    expect(mcpProfileFor('agent', '/mcp/connected')).toBeNull()
    expect(mcpProfileFor('agent', '/mcp/grokbot')).toBeNull()
    expect(mcpProfileFor('connected', '/mcp')).toBe('connected')
    expect(mcpProfileFor('connected', '/mcp/browser')).toBeNull()
    expect(mcpFor('app').token).toBe(agentToken())
    expect(mcpFor('connected').token).toBe(connectedToken())
    expect(connectedToken()).not.toBe(agentToken())
  })

  test('no tool argument can pass for your own press', () => {
    on()
    for (const name of ['submit_application', 'start_submit_batch']) expect(Object.keys(toolsFor('connected').find((t) => t.name === name)!.inputSchema)).not.toContain('by')
  })

  test('a batch goes through and says it was for your AI; turning it off stops the next form', async () => {
    on()
    const a = app('Sent', { stage: 'review' })
    const b = app('Next')
    await call('start_submit_batch', { mode: 'submit', applicationIds: [a.id, b.id] })
    await advance()
    const t = task(itemOf(a.id).taskId!)
    expect(t.input).toMatchObject({ submit: true, by: 'agent' })
    expect(getApplication(a.id)!.stage).toBe('approved')
    ai.replies = [filled, { outcome: 'submitted', summary: 'Thanks page.', problems: [] }]
    await run(t.id)
    expect(getApplication(a.id)!.stage).toBe('applied')
    on(false)
    await advance()
    expect(report()).toMatchObject({ status: 'paused', note: expect.stringContaining('your AI') })
    expect(itemOf(b.id).status).toBe('pending')
  })

  test('turned off after the form was queued, it fills but does not submit', async () => {
    on()
    const a = app('Late')
    await call('start_submit_batch', { mode: 'submit', applicationIds: [a.id] })
    await advance()
    on(false)
    ai.replies = [filled]
    await run(itemOf(a.id).taskId!)
    expect(getApplication(a.id)!.appliedAt).toBeNull()
  })

  test('off, it is refused at the start', () => {
    const a = app('Off')
    expect(() => batch.startBatch({ mode: 'submit', by: 'agent', applicationIds: [a.id] })).toThrow(/your AI submit is turned off \(Settings → AI\)/)
  })

  test('an essay you have not checked or an open question stays with you', async () => {
    on()
    const essay = app('Essay', { packageMd: ESSAY })
    const asked = app('Asked')
    askQuestions(asked.id, 'fill', [{ question: 'Are you authorized to work here?' }])
    const busy = app('Busy')
    db.insert(schema.tasks).values({ id: 'task_tune', kind: 'tune', title: 'Tune', status: 'queued', applicationId: busy.id, input: {} }).run()
    const clear = app('Clear')
    await call('start_submit_batch', { mode: 'submit', applicationIds: [essay.id, asked.id, busy.id, clear.id] })
    await advance()
    expect(itemOf(essay.id)).toMatchObject({ status: 'blocked', blockedBy: 'review', summary: expect.stringContaining('1 written answer not checked off') })
    expect(itemOf(asked.id)).toMatchObject({ status: 'blocked', blockedBy: 'review', summary: expect.stringContaining('1 open question') })
    expect(itemOf(busy.id)).toMatchObject({ status: 'blocked', blockedBy: 'review', summary: expect.stringContaining('still working') })
    expect(task(itemOf(clear.id).taskId!).input).toMatchObject({ submit: true, by: 'agent' })
  })

  test('checked off, it goes; a dry run never waits for the review', async () => {
    on()
    const a = app('Checked', { packageMd: ESSAY })
    await expect(call('submit_application', { applicationId: a.id })).resolves.toMatch(/Not sent\. Waiting on the user: 1 written answer/)
    await call('check_off_writing', { applicationId: a.id, key: 'cover-letter' })
    await expect(call('submit_application', { applicationId: a.id, dryRun: true })).resolves.toContain('taskId')
    db.delete(schema.tasks).run()
    await expect(call('submit_application', { applicationId: a.id })).resolves.toContain('taskId')
  })

  test('sent on its own, it still stops at a company limit', async () => {
    on()
    updateSettings('grokBot', { companyLimits: [{ company: 'Capped', max: 1, days: 60 }] })
    app('Capped', { stage: 'applied', appliedAt: new Date().toISOString() })
    const a = app('Capped')
    await expect(call('submit_application', { applicationId: a.id })).resolves.toMatch(/Not sent\. Capped limit/)
    expect(getApplication(a.id)!.stage).toBe('approved')
  })

  test('your answers carry its submit on as your AI, not as Grok Bot', async () => {
    on()
    const a = app('Answered')
    await call('submit_application', { applicationId: a.id })
    const first = db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).get()!
    ai.replies = [{ ...filled, outcome: 'needs_you', needsYou: [{ field: 'Salary?', why: 'Not in the package' }] }]
    await run(first.id)
    await call('answer_questions', { applicationId: a.id, answers: [{ question: 'Salary?', answer: 'Market rate' }] })
    const tasks = db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, a.id)).all()
    expect(tasks.find((t) => t.id !== first.id)!.input).toMatchObject({ submit: true, by: 'agent' })
  })

  test('a batch stored before this keeps counting as Grok Bot', async () => {
    allow()
    const a = app('Old')
    batch.startBatch({ mode: 'dry-run', applicationIds: [a.id] })
    setMeta('submitBatches', batch.listBatches().map(({ by: _by, ...b }) => b))
    expect(batch.listBatches()[0]).not.toHaveProperty('by')
    await advance()
    expect(task(itemOf(a.id).taskId!).input.by).toBe('grokbot')
  })
})
