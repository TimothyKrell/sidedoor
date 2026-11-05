import { eq } from 'drizzle-orm'
import { expect, test, vi } from 'vitest'

// Prep runs against a fake AI that records the prompt it was given and saves a package.
const ai = vi.hoisted(() => ({ prompts: [] as string[] }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { prompt: string }) => {
    ai.prompts.push(o.prompt)
    const id = /application id (\S+?),/.exec(o.prompt)?.[1]
    if (id) (await import('../src/services/applications')).updateApplication(id, { packageMd: `# Review ${ai.prompts.length}` })
    return { text: '', data: { summary: 'Prepared' }, log: ['read the listing'], sessionId: 'sess_1', costUsd: 0.01, provider: 'claude', model: 'm' }
  },
}))
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), buildResumePdf: async () => ({ pages: 1 }), tailoredFor: () => ({ id: 'res_x' }) }))

const { db, schema } = await import('../src/db/client')
const { nowIso } = await import('../src/ids')
const { executeTask } = await import('../src/jobs/tasks')
const { createApplication } = await import('../src/services/applications')
const { setDoc } = await import('../src/services/documents')
const { enqueueTask } = await import('../src/services/tasks')
const { selectExperience } = await import('../src/experience')
const { toolsFor } = await import('../src/mcp/tools')

const ROLES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay', 'Soylent', 'Wonka']
/** A long Experience document: role sections about ordinary work, then a newest section of confirmed answers. */
const longDoc = (perRole: number, extra = '') =>
  `# Experience\n\nEngineering leader.\n\n${ROLES.map(
    (c, i) => `## ${c} (${2010 + i}–${2011 + i})\n${Array.from({ length: perRole }, (_, j) => `- Led delivery of internal dashboards and reporting, release ${j}, for the ${c} product line.`).join('\n')}\n`,
  ).join('\n')}${extra}`

const CONFIRMED = `\n## Confirmed answers (Oct 30)\n- Built real-time collaborative editing with Yjs CRDTs on ProseMirror.\n- Ran durable workflows on Temporal.\n`

const prep = async (company: string, jd: string) => {
  const pid = `post_${company}`
  db.insert(schema.postings).values({ id: pid, key: pid, title: 'Engineering Manager, Frontend', companyName: company, jd, firstSeenAt: nowIso(), lastSeenAt: nowIso() }).run()
  const app = createApplication({ companyName: company, role: 'Engineering Manager, Frontend', stage: 'interested', postingId: pid })
  const t = enqueueTask('prep', `Prep: ${company}`, { applicationId: app.id, priority: 10, dedupe: false })
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
  ai.prompts.length = 0
  await executeTask({ ...t, status: 'running', attempts: 1 })
  const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!
  return { prompt: ai.prompts[0]!, task }
}

test('a fact only past offset 47K of a ~52K Experience doc reaches the prep prompt, and the log says what was supplied', async () => {
  const doc = longDoc(67, CONFIRMED)
  expect(doc.length).toBeGreaterThan(50_000)
  expect(doc.length).toBeLessThan(56_000)
  expect(doc.indexOf('Yjs CRDTs')).toBeGreaterThan(47_000)
  setDoc('experience', doc)
  const { prompt, task } = await prep('Clickco', 'Lead the frontend team building real-time collaboration (CRDTs, Yjs) and durable workflows.')
  expect(task.status).toBe('done')
  expect(prompt).toContain('Built real-time collaborative editing with Yjs CRDTs on ProseMirror.')
  expect(prompt).toContain('the later section is right')
  expect(task.log).toMatch(/Experience supplied: the whole document \(version [0-9a-f]{10}, 5\d,\d{3} characters/)
})

test('an Experience doc over the budget: the newest, confirmed and matching sections go in, the rest are listed with offsets', () => {
  const extra = `\n## Platform notes\n- Wrote Kubernetes operators in Go for the billing platform.\n${CONFIRMED}\n## Later notes\n- Mentored two new managers.\n`
  // The matching section sits in the middle of a long document, far from both ends.
  const doc = longDoc(120).replace('## Initech', `## Infra side project\n- Built a gRPC service mesh on Kubernetes.\n\n## Initech`) + extra
  expect(doc.length).toBeGreaterThan(80_000)
  const c = selectExperience(doc, 'Senior EM, platform. You will own our gRPC services on Kubernetes.', 30_000)
  expect(c.full).toBe(false)
  expect(c.text.length).toBeLessThan(34_000)
  expect(c.text).toContain('Built a gRPC service mesh on Kubernetes.') // matched the posting
  expect(c.text).toContain('Mentored two new managers.') // newest
  expect(c.text).toContain('Ran durable workflows on Temporal.') // newest
  expect(c.supplied.find((s) => s.heading.startsWith('## Infra side project'))).toMatchObject({ why: 'match', terms: expect.arrayContaining(['grpc']) })
  expect(c.omitted.length).toBeGreaterThan(0)
  for (const s of c.omitted) {
    expect(doc.slice(s.offset).startsWith(s.heading)).toBe(true)
    expect(c.text).toContain(`${s.heading} (offset ${s.offset},`)
  }
  // Every section is either supplied or listed.
  expect(c.supplied.length + c.omitted.length).toBe((doc.match(/^#{1,4} /gm) ?? []).length)
})

test('prep with an over-budget Experience doc still gets the section that matches the posting, and logs the sections', async () => {
  const doc = longDoc(260).replace('## Umbrella', '## Observability\n- Instrumented services with OpenTelemetry and ClickHouse.\n\n## Umbrella') + CONFIRMED
  expect(doc.length).toBeGreaterThan(130_000)
  setDoc('experience', doc)
  const { prompt, task } = await prep('Obsco', 'We want a manager who has run OpenTelemetry pipelines into ClickHouse.')
  expect(prompt).toContain('Instrumented services with OpenTelemetry and ClickHouse.')
  expect(prompt).toContain('Ran durable workflows on Temporal.')
  expect(prompt).toContain('## Sections not included above')
  expect(task.log).toMatch(/Experience supplied: \d+ of \d+ sections .*## Observability \[match: [^\]]*clickhouse/)
  expect(task.log).toMatch(/## Confirmed answers \(Oct 30\) \[newest\]/)
  expect(task.log).toMatch(/Left out: .*@\d+/)
})

const call = async (name: string, args: Record<string, unknown>) => {
  const t = toolsFor('app').find((x) => x.name === name)!
  const r = await t.handler(args)
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>
}

test('long agent reads say they were cut and give the offset to read on', async () => {
  const jd = `${'Responsibilities line.\n'.repeat(1000)}Last line of the JD.\n`
  db.insert(schema.postings).values({ id: 'post_long', key: 'post_long', title: 'EM', jd, firstSeenAt: nowIso(), lastSeenAt: nowIso() }).run()
  const p1 = await call('get_posting', { id: 'post_long' })
  expect(p1.jdTotalChars).toBe(jd.length)
  const p2 = await call('get_posting', { id: 'post_long', jdOffset: p1.jdNextOffset })
  // Each page comes fenced as data: what's inside the markers adds up to the whole posting.
  const inside = (t: unknown) => /source="job posting">\n([\s\S]*)\n<\/?\S*untrusted/.exec(String(t))?.[1] ?? ''
  expect((inside(p1.jd) + inside(p2.jd)).replace(/\s+/g, ' ').trim()).toBe(jd.replace(/\s+/g, ' ').trim())
  expect(p2.jdNextOffset).toBeNull()

  const notes = `${'A note.\n'.repeat(1000)}Final note.\n`
  const a = createApplication({ companyName: 'Notesco', role: 'EM', stage: 'interested', notesMd: notes })
  const g1 = await call('get_application', { id: a.id })
  const marker = /\[Truncated at ([\d,]+) of ([\d,]+) characters\. Read on: get_application \S+ with notesOffset (\d+)\]/.exec(String(g1.notes))!
  expect(marker).not.toBeNull()
  expect(String(g1.notes)).not.toContain('Final note.')
  const g2 = await call('get_application', { id: a.id, notesOffset: Number(marker[3]) })
  expect(String(g2.notes)).toContain('Final note.')

  const t = enqueueTask('custom', 'Long log', { dedupe: false })
  const log = `START ${'step\n'.repeat(4000)}END`
  db.update(schema.tasks).set({ log }).where(eq(schema.tasks.id, t.id)).run()
  const k1 = await call('get_task', { id: t.id })
  expect(String(k1.log)).toContain('END')
  expect(k1.logStartsAt).toBeGreaterThan(0)
  const k2 = await call('get_task', { id: t.id, logOffset: 0 })
  expect(String(k2.log)).toContain('START')
  expect(k2.logNextOffset).toBeTypeOf('number')
})

