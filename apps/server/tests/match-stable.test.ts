import { eq } from 'drizzle-orm'
import { beforeEach, expect, test, vi } from 'vitest'

// A deterministic scorer stands in for the AI: it reads the resume lines out of the prompt and
// judges each requirement by keyword. `wobble` makes it flip one verdict on every call, the way a
// real model does between runs on the same input.
const ai = vi.hoisted(() => ({ matchCalls: 0, wobble: false, prep: null as null | (() => Promise<unknown>) }))
vi.mock('../src/ai', async (orig) => ({
  ...(await orig<typeof import('../src/ai')>()),
  runJob: async (o: { job: string; prompt: string }) => {
    const base = { text: '', log: [], sessionId: 'sess_1', costUsd: 0.1, provider: 'claude', model: 'm' }
    if (o.job === 'prep') return { ...base, data: await ai.prep!() }
    if (o.job !== 'match') throw new Error('no AI for this job in tests')
    ai.matchCalls++
    const resume = o.prompt.split('# The resume')[1]!.split('# Experience document')[0]!
    const line = (word: string) => /\[(\S+)\] (.*)/g.exec(resume.split('\n').find((l) => l.includes(word)) ?? '')?.[1]
    const req = (id: string, short: string, area: string, word: string, hit: 'strong' | 'partial') => {
      const l = line(word)
      return { id, kind: 'must', area, short, quote: short, level: l ? hit : 'missing', evidence: l ? [{ line_id: l, short: word }] : [], note: '', fix: null }
    }
    return {
      ...base,
      data: {
        summary: 'Solid fit.',
        requirements: [
          req('r1', 'Go in production', 'skills', 'Go', ai.wobble && ai.matchCalls % 2 ? 'partial' : 'strong'),
          req('r2', 'Rust', 'skills', 'Rust', 'strong'),
          req('r3', 'Led a team', 'scope', 'Led', 'strong'),
        ],
      },
    }
  },
}))
vi.mock('../src/services/resumes', async (orig) => ({ ...(await orig<typeof import('../src/services/resumes')>()), buildResumePdf: async () => ({ pages: 1 }) }))

const { db, schema } = await import('../src/db/client')
const { executeTask } = await import('../src/jobs/tasks')
const { matchForAgent, runMatch } = await import('../src/match')
const { createApplication, getApplication, updateApplication } = await import('../src/services/applications')
const { addLine, createResume, saveContent, setLines, tailoredFor } = await import('../src/services/resumes')
const { enqueueTask } = await import('../src/services/tasks')

const mainResume = () => {
  const r = createResume({ title: 'Main resume' })
  const content = r.content
  const exp = content.sections.find((s) => s.type === 'experience')!
  if (exp.type === 'experience')
    exp.companies.push({
      id: 'co1',
      name: 'Acme',
      roles: [{ id: 'role1', title: 'Engineer', dates: '2020 – 2024', bullets: [{ id: 'b1', text: 'Built Go services for indexing.' }, { id: 'b2', text: 'Led a team of five.' }, { id: 'b3', text: 'Ran the on-call rotation.' }] }],
    })
  return saveContent(r.id, content, { by: 'user' }).resume
}

beforeEach(() => {
  ai.matchCalls = 0
  ai.wobble = false
  db.delete(schema.resumes).run()
})

const app = (company: string) => createApplication({ companyName: company, role: 'Backend Engineer', jobUrl: `https://jobs.example.com/${company}` })

test('the same resume and posting give the same stored score, without asking the AI again', async () => {
  mainResume()
  const a = app('Initech')
  const first = await runMatch(a.id)
  expect(first.reused).toBe(false)
  ai.wobble = true
  const again = await runMatch(a.id)
  expect(again.reused).toBe(true)
  expect(ai.matchCalls).toBe(1)
  expect(again.match.score).toBe(first.match.score)
  expect(getApplication(a.id)!.matchJson!.score).toBe(first.match.score)
})

test('editing an unrelated line leaves other verdicts alone, even when the AI wobbles', async () => {
  const r = mainResume()
  const a = app('Umbrella')
  const first = await runMatch(a.id)
  ai.wobble = true
  for (let i = 0; i < 3; i++) {
    setLines(r.id, { b3: `Ran the on-call rotation, round ${i}.` }, { by: 'user' })
    const m = await runMatch(a.id)
    expect(m.reused).toBe(false)
    expect(m.match.score).toBe(first.match.score)
  }
  const view = matchForAgent(getApplication(a.id)!)!
  expect(view).toMatchObject({ scoreChange: 0, improvedBeyondNoise: false })
})

test('the breakdown is stored and returned to agents', async () => {
  mainResume()
  const a = app('Vandelay')
  await runMatch(a.id)
  const stored = getApplication(a.id)!.matchJson!
  // Skills 40 + scope 25 → 61.5 / 38.5. Go strong, Rust missing: skills 30.8 of 61.5.
  expect(stored.breakdown!.map((c) => [c.criterion, c.points, c.max])).toEqual([
    ['skills', 30.8, 61.5],
    ['scope', 38.5, 38.5],
  ])
  expect(stored.score).toBe(69)
  expect(matchForAgent(getApplication(a.id)!)!.breakdown).toEqual([
    { criterion: 'skills', label: 'Must-have skills', points: 30.8, max: 61.5, gaps: [{ id: 'r2', short: 'Rust', level: 'missing', lost: 30.8 }] },
    { criterion: 'scope', label: 'Seniority and scope', points: 38.5, max: 38.5, gaps: [] },
  ])
})

const runPrep = async (a: { id: string }) => {
  const t = enqueueTask('prep', 'Prep', { applicationId: a.id, priority: 10, dedupe: false })
  db.update(schema.tasks).set({ status: 'running', attempts: 1 }).where(eq(schema.tasks.id, t.id)).run()
  await executeTask({ ...t, status: 'running', attempts: 1 })
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, t.id)).get()!
}

test("a prep pass's summary reports the stored score, and its last check isn't redone", async () => {
  mainResume()
  const a = app('Hooli')
  ai.prep = async () => {
    const tailored = tailoredFor(a.id)
    await runMatch(a.id) // check_resume_match, round 1
    addLine(tailored.id, 'b1', 'Wrote the Rust indexer.', 'agent')
    await runMatch(a.id) // round 2, on the final resume
    updateApplication(a.id, { packageMd: '# Review: Hooli' })
    // The AI misreports its own last score.
    return { summary: 'match 69 -> 100; questions: none' }
  }
  const task = await runPrep(a)
  expect(task.status).toBe('done')
  expect(ai.matchCalls).toBe(2)
  const stored = getApplication(a.id)!.matchJson!
  expect(stored.score).toBe(100)
  expect(task.output).toBe(`match 69 -> ${stored.score}; questions: none`)
  expect(stored.resumeVersion).toBe(String(tailoredFor(a.id).version))
  expect(db.select().from(schema.tasks).all().filter((t) => t.kind === 'match')).toEqual([])
})

test('edits after the last check get one final check, and the summary reports that score', async () => {
  mainResume()
  const a = app('Pied Piper')
  ai.prep = async () => {
    const tailored = tailoredFor(a.id)
    await runMatch(a.id)
    addLine(tailored.id, 'b1', 'Wrote the Rust indexer.', 'agent')
    updateApplication(a.id, { packageMd: '# Review: Pied Piper' })
    return { summary: 'match 69 -> 69; questions: none' }
  }
  const task = await runPrep(a)
  expect(ai.matchCalls).toBe(2)
  const stored = getApplication(a.id)!.matchJson!
  expect(stored.score).toBe(100)
  expect(task.output).toBe('match 69 -> 100; questions: none')
})
