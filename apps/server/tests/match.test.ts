import { describe, expect, test } from 'vitest'
import { matchScore, resumeLines } from '@sidedoor/shared/match'
import { buildMatch, matchForAgent } from '../src/match'
import { createApplication, getApplication, setResumeMatch, updateApplication } from '../src/services/applications'

const RESUME = `<!doctype html><html><head><style>.x { content: "data-id=\\"no\\"" }</style></head><body>
  <div class="stat" data-id="stat1"><span class="stat-num">6 &rarr; 15</span><span class="stat-label">Engineers scaled</span></div>
  <ul>
    <li data-id="b1">Scaled engineering from 6 to 15 engineers &amp; ran <b>hiring</b>.</li>
    <!-- <li data-id="old">commented out</li> -->
    <li data-id="b2">Built Go services for indexing.</li>
  </ul>
  <p data-id="empty"></p>
</body></html>`

const meta = { at: '2026-10-27T00:00:00.000Z', model: 'sonnet', doc: 'Acme - EM', resumeVersion: '1' }
const out = (reqs: Array<{ id?: string | null; short: string; level: 'strong' | 'partial' | 'weak' | 'missing'; lines?: string[] }>) => ({
  summary: 'ok',
  requirements: reqs.map((r) => ({ id: r.id ?? null, kind: 'must' as const, short: r.short, quote: r.short, level: r.level, evidence: (r.lines ?? []).map((l) => ({ line_id: l, short: l })), note: '', fix: null })),
})

describe('resumeLines', () => {
  test('reads each data-id line as plain text, skipping styles, comments and empty lines', () => {
    expect(resumeLines(RESUME)).toEqual([
      { id: 'stat1', text: '6 → 15 Engineers scaled' },
      { id: 'b1', text: 'Scaled engineering from 6 to 15 engineers & ran hiring.' },
      { id: 'b2', text: 'Built Go services for indexing.' },
    ])
  })
})

describe('match score', () => {
  test('must-haves weigh double; partial earns some credit', () => {
    expect(matchScore([])).toBe(0)
    expect(matchScore([{ kind: 'must', level: 'strong' }, { kind: 'nice', level: 'missing' }])).toBe(67)
    expect(matchScore([{ kind: 'must', level: 'partial' }])).toBe(60)
  })
})

describe('buildMatch', () => {
  const lines = resumeLines(RESUME)

  test('attaches line text and drops evidence on lines that do not exist', () => {
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2', 'nope'] }, { short: 'Rust', level: 'partial', lines: ['nope'] }]), lines, [], meta)
    expect(m.requirements[0]).toMatchObject({ id: 'r1', level: 'strong', evidence: [{ lineId: 'b2', text: 'Built Go services for indexing.' }] })
    // Claimed a match, but on no real line: that's missing.
    expect(m.requirements[1]).toMatchObject({ id: 'r2', level: 'missing', evidence: [] })
    expect(m.score).toBe(50)
  })

  test('re-checks keep known ids and number new items after them', () => {
    const first = buildMatch(out([{ short: 'Go', level: 'weak', lines: ['b2'] }, { short: 'Hiring', level: 'strong', lines: ['b1'] }]), lines, [], meta)
    const again = buildMatch(
      out([{ id: 'r2', short: 'Hiring', level: 'strong', lines: ['b1'] }, { id: 'r1', short: 'Go', level: 'strong', lines: ['b2'] }, { id: 'r1', short: 'Dup', level: 'missing' }, { short: 'New', level: 'missing' }]),
      lines,
      first.requirements,
      meta,
    )
    expect(again.requirements.map((r) => r.id)).toEqual(['r2', 'r1', 'r3', 'r4'])
  })
})

describe('setResumeMatch', () => {
  test('stores the check without counting as activity', () => {
    const a = createApplication({ companyName: 'Acme', role: 'EM' })
    const before = updateApplication(a.id, { notesMd: 'x' })!.lastActivityAt
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2'] }]), resumeLines(RESUME), [], meta)
    setResumeMatch(a.id, m)
    const after = getApplication(a.id)!
    expect(after.matchJson?.score).toBe(100)
    expect(after.lastActivityAt).toBe(before)
  })
})

describe('matchForAgent', () => {
  test('gives agents each verdict with its line ids, and flags a resume changed since the check', () => {
    const a = createApplication({ companyName: 'Acme', role: 'EM' })
    expect(matchForAgent(a)).toBeNull()
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2'] }, { short: 'Rust', level: 'missing' }]), resumeLines(RESUME), [], { ...meta, doc: 'main' })
    const r = matchForAgent(setResumeMatch(a.id, m)!)!
    expect(r).toMatchObject({ score: 50, doc: 'main', resumeChangedSince: true })
    expect(r.requirements).toMatchObject([
      { id: 'r1', short: 'Go', level: 'strong', lines: ['b2'] },
      { id: 'r2', short: 'Rust', level: 'missing', lines: [] },
    ])
  })
})
