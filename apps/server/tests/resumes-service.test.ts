import { expect, test } from 'vitest'
import { setLine } from '@sidedoor/shared/resume'
import { db, schema } from '../src/db/client'
import { createResume, requireResume, reviewAction, resumeChanges, saveContent, setLines, tailoredFor, versionsOf } from '../src/services/resumes'
import { createApplication } from '../src/services/applications'

const base = () => {
  const r = createResume({ title: 'Main resume' })
  const content = r.content
  const exp = content.sections.find((s) => s.type === 'experience')!
  if (exp.type === 'experience') exp.companies.push({ id: 'co1', name: 'Acme', roles: [{ id: 'r1', title: 'Engineer', dates: '2020 – 2024', bullets: [{ id: 'b1', text: 'Shipped the thing.' }] }] })
  return saveContent(r.id, content, { by: 'user' }).resume
}

test('saving many times keeps the last 50 snapshots', () => {
  const r = base()
  for (let i = 0; i < 60; i++) {
    const cur = requireResume(r.id)
    const res = saveContent(r.id, setLine(cur.content, 'b1', `Shipped the thing ${i}.`), { by: 'user', baseVersion: cur.version })
    expect(res.ok).toBe(true)
  }
  expect(versionsOf(r.id).length).toBe(50)
})

test('a stale base version is refused, not overwritten', () => {
  const r = base()
  const res = saveContent(r.id, setLine(r.content, 'b1', 'x'), { by: 'user', baseVersion: r.version - 1 })
  expect(res.ok).toBe(false)
})

test("the user's own edits don't need review; an agent's do, until kept or undone", () => {
  const r = base()
  setLines(r.id, { b1: 'Shipped it twice.' }, { by: 'user' })
  expect(resumeChanges(requireResume(r.id))).toEqual([])
  setLines(r.id, { b1: 'Shipped it three times.' }, { by: 'agent' })
  expect(resumeChanges(requireResume(r.id)).map((c) => c.id)).toEqual(['b1'])
  reviewAction(r.id, 'undo', 'b1')
  const back = requireResume(r.id)
  expect(resumeChanges(back)).toEqual([])
  expect(JSON.stringify(back.content)).toContain('Shipped it twice.')
})

test('a tailored copy starts from the main resume and shows the tailoring as changes', () => {
  base()
  const a = createApplication({ companyName: 'Initech', role: 'Staff Engineer', stage: 'interested', status: 'active' })
  const t = tailoredFor(a.id)
  expect(t.kind).toBe('tailored')
  expect(tailoredFor(a.id).id).toBe(t.id)
  setLines(t.id, { b1: 'Shipped the thing for Initech.' }, { by: 'agent' })
  expect(resumeChanges(requireResume(t.id)).length).toBe(1)
  expect(db.select().from(schema.applications).all().find((x) => x.id === a.id)?.resumeId).toBe(t.id)
})
