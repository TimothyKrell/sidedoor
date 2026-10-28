import type { IncomingMessage } from 'node:http'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { db, schema } from '../src/db/client'
import { agentFor } from '../src/http/auth'
import { finishTask, grokBotKinds, grokBotSeen, grokBotStatus, grokBotTick, STALE_MS, takeTask } from '../src/jobs/handoff'
import { claimNextTask } from '../src/jobs/tasks'
import { toolsFor } from '../src/mcp/tools'
import { agentToken, grokBotToken, setSecret } from '../src/secrets'
import { createApplication } from '../src/services/applications'
import { linkPerson, upsertPerson } from '../src/services/people'
import { enqueueTask } from '../src/services/tasks'
import { updateSettings } from '../src/settings'

const task = (id: string) => db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!
const req = (token?: string) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} }) as IncomingMessage
const app = (companyName: string) => createApplication({ companyName, role: 'Engineering Manager', stage: 'interested' })

const turnOn = (o: { research?: boolean; x?: boolean } = { research: true }) => {
  grokBotToken(true)
  updateSettings('grokBot', { research: false, x: false, webhookUrl: '', ...o })
}

afterEach(() => {
  setSecret('grokbot-token', '')
  setSecret('grokbot-webhook-key', '')
  updateSettings('grokBot', { research: false, x: false, webhookUrl: '' })
  db.delete(schema.tasks).run()
  vi.unstubAllGlobals()
})

describe('Grok Bot connects with its own token', () => {
  test('it only works once Grok Bot is turned on, and is told apart from our agents', () => {
    expect(agentFor(req())).toBeNull()
    expect(agentFor(req('sdg_guess'))).toBeNull()
    expect(agentFor(req(agentToken()))).toBe('agent')
    const t = grokBotToken(true)
    expect(agentFor(req(t))).toBe('grokbot')
    setSecret('grokbot-token', '')
    expect(agentFor(req(t))).toBeNull()
  })

  test('Settings can tell once Grok Bot has connected', () => {
    turnOn()
    grokBotSeen()
    expect(grokBotStatus().seenAt).toBeTruthy()
  })

  test('only Grok Bot sees its task queue tools', () => {
    const names = (p: 'app' | 'grokbot') => toolsFor(p).map((t) => t.name)
    expect(names('grokbot')).toEqual(expect.arrayContaining(['take_task', 'finish_task', 'upsert_person', 'save_research']))
    expect(names('app')).not.toContain('take_task')
  })
})

describe('research sent to Grok Bot', () => {
  test('waits for Grok Bot instead of running here, and runs here again when Grok Bot is off', () => {
    const a = app('Acme')
    const t = enqueueTask('research', 'Research: Acme', { applicationId: a.id })
    turnOn()
    expect(grokBotKinds()).toEqual(['research'])
    expect(claimNextTask()).toBeNull()
    setSecret('grokbot-token', '')
    expect(claimNextTask()?.id).toBe(t.id)
  })

  test('Grok Bot takes it, gets the research instructions, and finishing does the usual bookkeeping', async () => {
    const a = app('Globex')
    const t = enqueueTask('research', 'Research: Globex', { applicationId: a.id })
    turnOn()

    const took = await takeTask(t.id)
    expect(took?.instructions).toContain('Globex')
    expect(task(t.id)).toMatchObject({ status: 'running', provider: 'grokbot' })
    expect(await takeTask()).toBeNull()

    const p = upsertPerson({ name: 'Hiring Manager', companyName: 'Globex' })
    linkPerson(a.id, p.id, 'hiring manager')
    await finishTask(t.id, { summary: 'Found the hiring manager.' })

    expect(task(t.id)).toMatchObject({ status: 'done', output: 'Found the hiring manager.' })
    // A linked person means outreach comes next, exactly as when research runs here.
    const outreach = db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'outreach')).all()
    expect(outreach).toMatchObject([{ applicationId: a.id, status: 'queued' }])
  })

  test('a task it did not take cannot be finished, and an error fails it', async () => {
    const a = app('Initech')
    const t = enqueueTask('research', 'Research: Initech', { applicationId: a.id })
    turnOn()
    await expect(finishTask(t.id, { summary: 'done' })).rejects.toThrow(/not waiting for Grok Bot/)
    await takeTask(t.id)
    await finishTask(t.id, { error: 'The company has no public team page.' })
    expect(task(t.id)).toMatchObject({ status: 'failed', error: 'Grok Bot: The company has no public team page.' })
  })

  test('X research goes only when that is turned on', () => {
    enqueueTask('x-scout', 'Research on X', {})
    turnOn({ research: true, x: false })
    expect(claimNextTask()?.kind).toBe('x-scout')
    db.delete(schema.tasks).run()
    enqueueTask('x-scout', 'Research on X', {})
    turnOn({ x: true })
    expect(claimNextTask()).toBeNull()
  })
})

describe('waking Grok Bot', () => {
  test('posts the task to the routine webhook with its key, once', async () => {
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: new Headers(init.headers).get('authorization') ?? '', body: JSON.parse(String(init.body)) })
      return new Response('{}', { status: 200 })
    })
    const a = app('Hooli')
    const t = enqueueTask('research', 'Research: Hooli', { applicationId: a.id })
    turnOn({ research: true, webhookUrl: 'https://example.test/automations/webhook/r1' } as never)
    setSecret('grokbot-webhook-key', 'crsr_key')

    await grokBotTick()
    await grokBotTick()

    expect(calls).toEqual([{ url: 'https://example.test/automations/webhook/r1', auth: 'Bearer crsr_key', body: { sidedoor: 'task', taskId: t.id, kind: 'research', title: 'Research: Hooli' } }])
  })

  test('a task Grok Bot took and never finished goes back in the queue', async () => {
    const a = app('Umbrella')
    const t = enqueueTask('research', 'Research: Umbrella', { applicationId: a.id })
    turnOn()
    await takeTask(t.id)
    db.update(schema.tasks).set({ startedAt: new Date(Date.now() - STALE_MS - 60_000).toISOString() }).where(eq(schema.tasks.id, t.id)).run()
    await grokBotTick()
    expect(task(t.id).status).toBe('queued')
  })
})
