import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

// The AI's answers, in order. A prep that's refused never asks.
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
    finish: async () => void tab.calls.push('finish'),
    unguard: async () => void tab.calls.push('unguard'),
    close: async () => void tab.calls.push('close'),
  }),
}))
vi.mock('../src/mcp/playwright', () => ({ withBrowserTools: (_e: string, _d: string, fn: () => Promise<unknown>) => fn() }))
const pdf = join(mkdtempSync(join(tmpdir(), 'sd-pdf-')), 'Resume.pdf')
writeFileSync(pdf, '%PDF')
vi.mock('../src/services/resumes', async (orig) => ({
  ...(await orig<typeof import('../src/services/resumes')>()),
  resumeForApplication: () => ({ id: 'res_x', pdfFile: null }),
  buildResumePdf: async () => ({ path: pdf, pages: 1 }),
  tailoredFor: () => ({ id: 'res_x' }),
}))
vi.mock('../src/mcp/server', async (orig) => ({ ...(await orig<typeof import('../src/mcp/server')>()), browserSnapshot: async () => '### Page\n- Page URL: https://jobs.example.com/thanks' }))
vi.mock('../src/notify', async (orig) => ({ ...(await orig<typeof import('../src/notify')>()), notifyPromise: async () => undefined }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { submissions } = await import('../src/jobs/fill-form')
const { toolsFor } = await import('../src/mcp/tools')
const { grokBotToken, setSecret } = await import('../src/secrets')
const { createApplication, getApplication, requestSubmit, updateApplication } = await import('../src/services/applications')
const { checkApplicationRules, checkOpenApplications, clearRulesOverride, overrideRules } = await import('../src/services/rules')
const { enqueueTask } = await import('../src/services/tasks')
const { updateSettings } = await import('../src/settings')

const now = new Date().toISOString()
let n = 0
/** An application backed by a posting, the way tracking a scouted job makes one. */
const app = (company: string, p: { location?: string; compText?: string | null; jd?: string } = {}, o: Partial<typeof schema.applications.$inferInsert> = {}) => {
  const postingId = `pst_${++n}`
  db.insert(schema.postings)
    .values({ id: postingId, key: `test:${postingId}`, companyName: company, title: 'Engineering Manager', location: p.location ?? 'Remote - US', compText: p.compText ?? '$260,000 - $320,000', jd: p.jd ?? 'Lead the platform team.', firstSeenAt: now, lastSeenAt: now })
    .run()
  return createApplication({ companyName: company, role: 'Engineering Manager', stage: 'review', postingId, applyUrl: `https://jobs.example.com/${company}`, packageMd: '# Package\n\n### Why us?\nBecause.', ...o })
}
const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const run = async (id: string) => {
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, id)).run()
  await executeTask({ ...task(id), status: 'running', attempts: 1 })
  return task(id)
}
const prep = (applicationId: string) => enqueueTask('prep', 'Prep', { applicationId, priority: 10, dedupe: false })
const tool = (name: string) => toolsFor('grokbot').find((t) => t.name === name)!
const call = async (name: string, args: Record<string, unknown>) => {
  const r = await tool(name).handler(args)
  const text = r.content[0]!.text
  return r.isError ? { error: text } : JSON.parse(text)
}
const HYBRID = { location: 'New York, NY', jd: 'This is a hybrid role, three days a week in our New York office.' }

beforeEach(() => {
  updateSettings('rules', { enabled: true, remoteOnly: true, compFloor: 230_000, targetMin: 400_000, targetMax: 500_000, citizenship: 'flag', clearance: 'flag' })
  grokBotToken(true)
  updateSettings('grokBot', { submit: true })
})
afterEach(() => {
  updateSettings('rules', { remoteOnly: false, compFloor: null, targetMin: null, targetMax: null })
  setSecret('grokbot-token', '')
  updateSettings('grokBot', { submit: false })
  db.delete(schema.tasks).run()
  db.update(schema.applications).set({ status: 'closed-lost' }).run()
  ai.replies = []
  ai.prompts = []
  tab.calls = []
})

describe('before prep', () => {
  test('a role that breaks the rules is not prepared, and says why', async () => {
    const a = app('Hybridco', HYBRID, { packageMd: null, stage: 'interested' })
    const t = await run(prep(a.id).id)
    expect(ai.prompts).toEqual([])
    expect(t.status).toBe('done')
    expect(t.output).toContain('Not prepared: it breaks your rules. The description asks for office time ("This is a hybrid role, three days a week in our New York office.")')
    const after = getApplication(a.id)!
    expect(after.nextAction).toMatch(/^Not prepared: breaks your rules/)
    expect(after.rulesJson).toMatchObject({ result: 'fail', findings: expect.arrayContaining([expect.objectContaining({ rule: 'remote', outcome: 'fail' })]) })
  })

  test('a flagged role is prepared, and the AI is told about the flag', async () => {
    const a = app('Govco', { jd: 'Candidates must be U.S. citizens.' }, { packageMd: null, stage: 'interested' })
    ai.replies = [{ summary: 'Prepared.' }]
    // The stand-in AI saves no package, so the task fails after; what matters is that it ran, told of the flag.
    await run(prep(a.id).id)
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain("Rule check (the user's hard rules")
    expect(ai.prompts[0]).toContain('Candidates must be U.S. citizens.')
    expect(getApplication(a.id)!.rulesJson?.result).toBe('flag')
  })

  test('going ahead anyway lets prep run', async () => {
    const a = app('Hybridco2', HYBRID, { packageMd: null, stage: 'interested' })
    overrideRules(a.id, { by: 'you', note: 'I know the team' })
    ai.replies = [{ summary: 'Prepared.' }]
    await run(prep(a.id).id)
    expect(ai.prompts).toHaveLength(1)
    expect(ai.prompts[0]).toContain('the user chose to go ahead anyway')
  })
})

describe('before submit', () => {
  test('submit refuses a role that breaks the rules, until the user overrides it', async () => {
    const a = app('Lowpay', { compText: '$140,000 - $190,000' })
    expect(() => requestSubmit(a.id)).toThrow(/breaks the user's rules\. Base tops out at \$190K, under your \$230K floor.*override_rules/)
    expect(getApplication(a.id)!.stage).toBe('review')
    // Through Grok Bot's tool, the same.
    expect((await call('submit_application', { applicationId: a.id })).error).toMatch(/breaks the user's rules/)
    // A dry run never submits, so it may fill the form.
    expect(requestSubmit(a.id, { dryRun: true }).input).toMatchObject({ dryRun: true })
    db.delete(schema.tasks).run()

    const o = await call('override_rules', { applicationId: a.id, note: 'Tim: worth it for the mission' })
    expect(o.override).toMatchObject({ by: 'agent', note: 'Tim: worth it for the mission', rules: ['pay'] })
    const t = requestSubmit(a.id)
    expect(t.input).toMatchObject({ submit: true, dryRun: false })
    expect(getApplication(a.id)!.stage).toBe('approved')

    // Taking the override back blocks it again.
    db.delete(schema.tasks).run()
    clearRulesOverride(a.id)
    expect(() => requestSubmit(a.id)).toThrow(/breaks the user's rules/)
  })

  test('an override covers only the rules that failed when it was given', () => {
    const a = app('Lowpay2', { compText: '$140,000 - $190,000' })
    overrideRules(a.id, { by: 'you' })
    updateSettings('rules', { clearance: 'fail' })
    updateApplication(a.id, { packageMd: '# Package\n\n### Do you hold an active security clearance?\nNo.' })
    expect(() => requestSubmit(a.id)).toThrow(/Asks for a security clearance/)
  })

  test('the fill checks again with the form’s own questions, and holds back the submit click', async () => {
    updateSettings('rules', { clearance: 'fail' })
    const a = app('Clearco')
    const t = requestSubmit(a.id)
    ai.replies = [{ outcome: 'ready', summary: 'All filled.', filled: [{ field: 'Do you currently hold an active security clearance?', value: 'No', source: 'package' }], needsYou: [] }]
    expect((await run(t.id)).status).toBe('done')
    // Only the fill ran: no submit step, and the form stays open for the user.
    expect(ai.prompts).toHaveLength(1)
    expect(tab.calls).toEqual(['finish'])
    const after = getApplication(a.id)!
    expect(after.stage).toBe('approved')
    expect(after.appliedAt).toBeNull()
    expect(after.nextAction).toMatch(/^Not submitted: breaks your rules \(Asks for a security clearance\)/)
    expect(submissions(a.id)[0]).toMatchObject({ status: 'not_submitted', summary: expect.stringContaining('override_rules') })
  })
})

describe('across open applications', () => {
  test('lists what breaks the rules, fails first, and agents see it on each application', async () => {
    const good = app('Goodco', { compText: '$420,000 - $480,000' })
    const bad = app('Hybridco3', HYBRID)
    const flagged = app('Flagco', { jd: 'Must be a U.S. citizen or green card holder.' })
    const r = checkOpenApplications()
    expect(r.counts).toMatchObject({ checked: 3, pass: 1, flag: 1, fail: 1 })
    expect(r.violations.map((v) => v.company)).toEqual(['Hybridco3', 'Flagco'])
    expect(r.violations[0]!.findings[0]).toMatchObject({ rule: 'remote', outcome: 'fail', quote: 'This is a hybrid role, three days a week in our New York office.' })

    expect(await call('list_applications', { rules: 'fail' })).toMatchObject([{ id: bad.id, rules: 'fail: The description asks for office time' }])
    expect((await call('list_applications', {})).find((x: { id: string }) => x.id === good.id)).toMatchObject({ rules: 'pass', payBand: 'target' })
    expect((await call('get_application', { id: flagged.id })).ruleCheck).toMatchObject({ result: 'flag', findings: expect.arrayContaining([expect.objectContaining({ rule: 'citizenship', quote: 'Must be a U.S. citizen or green card holder.' })]) })
    expect((await call('check_rules', {})).violations).toHaveLength(2)
  })

  test('rules are settings an agent can read and change, and turning them off stops the checks', async () => {
    expect(await call('update_rules', {})).toMatchObject({ remoteOnly: true, compFloor: 230_000, currency: 'USD' })
    expect(await call('update_rules', { compFloor: 250_000 })).toMatchObject({ compFloor: 250_000, remoteOnly: true })
    await call('update_rules', { enabled: false })
    const a = app('Anyco', HYBRID)
    expect(checkApplicationRules(a.id)).toBeNull()
    expect(requestSubmit(a.id).kind).toBe('submit-assist')
    await call('update_rules', { enabled: true })
  })
})
