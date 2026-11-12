import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, test, vi } from 'vitest'

type Flag = { key: string; sentence: string; fact: string; suggestion?: string | null }
const ai = vi.hoisted(() => ({ calls: [] as string[], reply: (_prompt: string): Flag[] => [] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.calls.push(o.prompt)
    return { text: '', data: { flags: ai.reply(o.prompt) }, log: [], sessionId: null, costUsd: 0, provider: 'claude', model: 'm' }
  },
}))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { docDiff, termsOf } = await import('../src/jobs/stale-check')
const { getDoc, setDoc, appendDoc } = await import('../src/services/documents')
const { createDraft, markDraftSent, updateDraft, upsertPerson } = await import('../src/services/people')
const { createApplication, updateApplication } = await import('../src/services/applications')
const { checkStaleNow, clearStaleFlag, listStaleFlags } = await import('../src/services/stale-flags')
const { profileTools } = await import('../src/mcp/profile-tools')

const HAVENT = "I haven't built on Yjs myself, but I've followed its CRDT design closely."

/** Run every stale check that's queued, as the task loop would once its settle delay passes. */
const runChecks = async () => {
  const queued = db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'stale-check')).all().filter((t) => t.status === 'queued')
  for (const t of queued) {
    db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
    await executeTask({ ...t, status: 'running', attempts: 1 })
  }
  return queued.map((t) => db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!)
}

/** The AI finds the sentence wherever it was shown, in every piece it was given (even the wrong ones). */
const flagHavent = (prompt: string): Flag[] =>
  [...prompt.matchAll(/### Piece key="([^"]+)"[^\n]*\n<<<TEXT\n([\s\S]*?)\nTEXT>>>/g)]
    .filter((m) => m[2]!.includes("haven't built on Yjs"))
    .map((m) => ({ key: m[1]!, sentence: HAVENT, fact: 'Has built collaborative editing with CRDTs, Yjs and ProseMirror.', suggestion: "I've built collaborative editing on Yjs and ProseMirror." }))

const tool = (name: string) => profileTools.find((t) => t.name === name)!
const callTool = async (name: string, args: Record<string, unknown>) => JSON.parse((await tool(name).handler(args)).content[0]!.text)

beforeEach(() => {
  ai.calls = []
  ai.reply = flagHavent
})

describe('drafts that a profile change makes stale', () => {
  const person = upsertPerson({ name: 'Pat Example', companyName: 'Docsy' })
  let unsent: { id: string }
  let sent: { id: string }
  let app: { id: string }

  test('setup: Experience exists and has been checked once', async () => {
    setDoc('experience', '# Experience\n\nLed the payments team at Acme for four years.\n')
    await runChecks()
    unsent = createDraft({ personId: person.id, channel: 'email', subject: 'Editor role', body: `Hi Pat,\n\n${HAVENT} Would love to talk.` })
    sent = createDraft({ personId: person.id, channel: 'email', subject: 'Earlier note', body: `Hi again,\n\n${HAVENT}` })
    markDraftSent(sent.id)
    const submitted = createApplication({ companyName: 'Docsy', role: 'Staff Engineer', stage: 'applied' })
    updateApplication(submitted.id, { packageMd: `## Cover letter\n\n${HAVENT} I have led payment teams and shipped many things over the years, which is enough text.\n` })
    app = createApplication({ companyName: 'Docsy', role: 'Editor Lead', stage: 'review' })
    updateApplication(app.id, { packageMd: `# Package\n\n## Cover letter\n\nDear team, I led the payments team at Acme for four years and want to build editors next with you.\n` })
  })

  test('an edit adding "has built on Yjs" flags the draft that says "haven\'t built on Yjs"', async () => {
    appendDoc('experience', '## Collaborative editing\nHas built on Yjs: real-time collaborative editing with CRDTs, Yjs and ProseMirror.')
    const [task] = await runChecks()
    expect(task).toMatchObject({ status: 'done' })
    expect(ai.calls).toHaveLength(1)
    expect(ai.calls[0]).toContain('Has built on Yjs')
    expect(ai.calls[0]).toContain(`draft:${unsent.id}`)

    const flags = listStaleFlags()
    expect(flags).toHaveLength(1)
    expect(flags[0]).toMatchObject({ draftId: unsent.id, docKey: 'experience', sentence: HAVENT, status: 'open', suggestion: "I've built collaborative editing on Yjs and ProseMirror." })
    expect(flags[0]!.fact).toContain('Yjs')
    expect(flags[0]!.label).toContain('Pat Example')
    // The draft itself is untouched.
    expect(db.select().from(schema.drafts).where(eq(schema.drafts.id, unsent.id)).get()!.body).toContain(HAVENT)
  })

  test('sent drafts and submitted applications are ignored, even if the AI names them', async () => {
    appendDoc('experience', 'Shipped Yjs presence and offline sync for the editor.')
    ai.reply = (p) => [...flagHavent(p), { key: `draft:${sent.id}`, sentence: HAVENT, fact: 'Has built on Yjs.' }]
    await runChecks()
    expect(ai.calls[0]).not.toContain(sent.id)
    expect(ai.calls[0]).not.toContain('Staff Engineer')
    // Still one flag: the sent draft got none, and the open one isn't duplicated.
    expect(listStaleFlags().map((f) => f.draftId)).toEqual([unsent.id])
  })

  test('an unrelated edit flags nothing and never asks the AI', async () => {
    appendDoc('experience', 'Ran the 2019 Boston marathon.')
    const [task] = await runChecks()
    expect(task).toMatchObject({ status: 'done' })
    expect(task!.output).toMatch(/no unsent draft mentions them/)
    expect(ai.calls).toHaveLength(0)
    expect(listStaleFlags()).toHaveLength(1)
  })

  test('a sentence the AI made up is not flagged', async () => {
    appendDoc('experience', 'Wrote the ProseMirror schema for tables.')
    ai.reply = () => [{ key: `draft:${unsent.id}`, sentence: 'I have never touched ProseMirror.', fact: 'Wrote the ProseMirror schema.' }]
    await runChecks()
    expect(listStaleFlags()).toHaveLength(1)
  })

  test('flags show up through MCP, and clearing one there takes it off the list', async () => {
    const listed = await callTool('list_stale_drafts', {})
    expect(listed).toMatchObject([{ draftId: unsent.id, sentence: HAVENT, status: 'open' }])
    expect(await callTool('clear_stale_flag', { flagId: listed[0].flagId, note: 'fine as written' })).toMatchObject({ status: 'cleared' })
    expect(await callTool('list_stale_drafts', {})).toEqual([])
    expect(await callTool('list_stale_drafts', { all: true })).toMatchObject([{ status: 'cleared', note: 'fine as written' }])
  })

  test('fixing the sentence resolves the flag by itself', async () => {
    const queued = checkStaleNow(['experience'], { full: true })
    expect(queued).toHaveLength(1)
    await runChecks()
    const [flag] = listStaleFlags()
    expect(flag).toBeDefined()
    updateDraft(unsent.id, { body: "Hi Pat,\n\nI've built collaborative editing on Yjs. Would love to talk." })
    expect(listStaleFlags()).toEqual([])
    expect(listStaleFlags({ all: true }).find((f) => f.id === flag!.id)).toMatchObject({ status: 'resolved', note: 'The sentence was changed' })
    expect(() => clearStaleFlag('stale_missing')).toThrow()
  })

  test('several quick saves share one waiting check', () => {
    appendDoc('answers', 'Authorized to work in the US.')
    appendDoc('answers', 'Start date: two weeks after an offer.')
    const waiting = db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'stale-check')).all().filter((t) => t.status === 'queued')
    expect(waiting).toHaveLength(1)
    expect(waiting[0]!.input).toEqual({ docKey: 'answers' })
    // Search criteria and writing style aren't facts drafts repeat.
    setDoc('writing', 'Short sentences.')
    expect(db.select().from(schema.tasks).where(eq(schema.tasks.kind, 'stale-check')).all().filter((t) => t.status === 'queued')).toHaveLength(1)
    expect(getDoc('answers').body).toContain('two weeks')
  })
})

describe('the diff and the prefilter', () => {
  test('only changed sentences count', () => {
    const d = docDiff('Led payments at Acme. Wrote Go.\n\n- Ran on-call', 'Led payments at Acme. Wrote Go and Rust.\n\n- Ran on-call')
    expect(d).toEqual({ added: ['Wrote Go and Rust.'], removed: ['Wrote Go.'] })
  })

  test('distinctive words survive, common ones and contractions do not', () => {
    const t = termsOf("Has built on Yjs with CRDTs and ProseMirror; haven't worked in 2019")
    expect([...t]).toEqual(expect.arrayContaining(['yjs', 'crdt', 'prosemirror', '2019']))
    expect(t.has('built')).toBe(false)
    expect(t.has("haven't")).toBe(false)
  })
})

describe('repeat flags', () => {
  test('the same line quoted with its checkbox or a sentence more is one flag', async () => {
    const pkgApp = createApplication({ companyName: 'Docsy', role: 'Survey Lead', stage: 'review' })
    const line = 'Diversity survey (optional): drafted as Man / White / prefer not to answer on veteran status, per your standard answers.'
    updateApplication(pkgApp.id, { packageMd: `# Package\n\n## Needs your decision\n- [x] ${line} Change it or skip it if you like.\n` })
    appendDoc('answers', 'Veteran status: not a veteran.')
    ai.reply = () => [{ key: `pkg:${pkgApp.id}:rest`, sentence: line, fact: 'Veteran status: not a veteran.' }]
    await runChecks()
    appendDoc('answers', 'Disability: decline to self-identify; veteran status still not a veteran.')
    ai.reply = () => [{ key: `pkg:${pkgApp.id}:rest`, sentence: `- [x] ${line} Change it or skip it if you like.`, fact: 'Veteran status: not a veteran.' }]
    await runChecks()
    expect(listStaleFlags({ applicationId: pkgApp.id }).map((f) => f.sentence)).toEqual([line])
    updateApplication(pkgApp.id, { stage: 'closed' })
  })
})
