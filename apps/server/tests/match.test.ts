import { describe, expect, test } from 'vitest'
import { matchScore, resumeLines, scoreMatch } from '@sidedoor/shared/match'
import { buildMatch, matchForAgent, withStoredScore } from '../src/match'
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

const meta = { at: '2026-10-27T00:00:00.000Z', model: 'sonnet', doc: 'Acme - EM', resumeVersion: '1', jdKey: 'Go and hiring' }
const out = (reqs: Array<{ id?: string | null; short: string; level: 'strong' | 'partial' | 'weak' | 'missing'; lines?: string[]; area?: 'skills' | 'scope' | 'domain' | 'logistics' }>) => ({
  summary: 'ok',
  requirements: reqs.map((r) => ({ id: r.id ?? null, kind: 'must' as const, area: r.area ?? ('skills' as const), short: r.short, quote: r.short, level: r.level, evidence: (r.lines ?? []).map((l) => ({ line_id: l, short: l })), note: '', fix: null })),
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

describe('match score (rubric v2)', () => {
  const req = (kind: 'must' | 'nice', area: 'skills' | 'scope' | 'domain' | 'logistics', level: 'strong' | 'partial' | 'weak' | 'missing', id: string = area) => ({ id, kind, area, level, short: id, note: '', fix: null })

  test('fixed budgets per criterion; an absent criterion hands its budget to the rest', () => {
    expect(matchScore([])).toBe(0)
    expect(matchScore([{ kind: 'must', area: 'skills', level: 'partial' }])).toBe(60)
    // Skills 40 + nice 10 → 80/20 of the score.
    expect(matchScore([{ kind: 'must', area: 'skills', level: 'strong' }, { kind: 'nice', area: 'skills', level: 'missing' }])).toBe(80)
    // Checks from before v2 have no area: their must-haves count as skills.
    expect(matchScore([{ kind: 'must', level: 'strong' }])).toBe(100)
  })

  test('the breakdown adds up to the score and names the points each gap lost', () => {
    const { score, breakdown } = scoreMatch([req('must', 'skills', 'strong', 'go'), req('must', 'skills', 'weak', 'rust'), req('must', 'scope', 'strong'), req('must', 'domain', 'missing'), req('must', 'logistics', 'strong'), req('nice', 'domain', 'partial', 'k8s')])
    expect(breakdown.map((c) => [c.criterion, c.points, c.max])).toEqual([
      ['skills', 25, 40],
      ['scope', 25, 25],
      ['domain', 0, 15],
      ['logistics', 10, 10],
      ['nice', 6, 10],
    ])
    expect(score).toBe(66)
    expect(breakdown[0]!.gaps).toEqual([{ id: 'rust', short: 'rust', level: 'weak', lost: 15, note: '', fix: null }])
    expect(breakdown[2]!.gaps[0]).toMatchObject({ id: 'domain', lost: 15 })
  })
})

describe('buildMatch', () => {
  const lines = resumeLines(RESUME)

  test('attaches line text and drops evidence on lines that do not exist', () => {
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2', 'nope'] }, { short: 'Rust', level: 'partial', lines: ['nope'] }]), lines, null, meta)
    expect(m.requirements[0]).toMatchObject({ id: 'r1', level: 'strong', evidence: [{ lineId: 'b2', text: 'Built Go services for indexing.' }] })
    // Claimed a match, but on no real line: that's missing.
    expect(m.requirements[1]).toMatchObject({ id: 'r2', level: 'missing', evidence: [] })
    expect(m.score).toBe(50)
  })

  test('when the posting changed, re-checks keep known ids and number new items after them', () => {
    const first = buildMatch(out([{ short: 'Go', level: 'weak', lines: ['b2'] }, { short: 'Hiring', level: 'strong', lines: ['b1'] }]), lines, null, meta)
    const again = buildMatch(
      out([{ id: 'r2', short: 'Hiring', level: 'strong', lines: ['b1'] }, { id: 'r1', short: 'Go', level: 'strong', lines: ['b2'] }, { id: 'r1', short: 'Dup', level: 'missing' }, { short: 'New', level: 'missing' }]),
      lines,
      first,
      { ...meta, jdKey: 'the posting was edited' },
    )
    expect(again.requirements.map((r) => r.id)).toEqual(['r2', 'r1', 'r3', 'r4'])
  })

  test('same posting: the list is frozen and untouched requirements keep their verdict', () => {
    const first = buildMatch(out([{ short: 'Go', level: 'partial', lines: ['b2'] }, { short: 'Hiring', level: 'strong', lines: ['b1'] }, { short: 'Rust', level: 'missing' }]), lines, null, meta)
    // Nothing changed, but the model wobbles, reorders, renames and adds an item.
    const noisy = out([{ id: 'r2', short: 'Hiring!', level: 'partial', lines: ['b1'] }, { id: 'r1', short: 'Go', level: 'strong', lines: ['b2'] }, { short: 'Extra', level: 'missing' }])
    const again = buildMatch(noisy, lines, first, meta)
    expect(again.requirements.map((r) => [r.id, r.short, r.level])).toEqual([
      ['r1', 'Go', 'partial'],
      ['r2', 'Hiring', 'strong'],
      ['r3', 'Rust', 'missing'],
    ])
    expect(again.score).toBe(first.score)
    expect(again.previousScore).toBe(first.score)
    // Edit the Go line: only the requirement citing it is re-judged.
    const edited = lines.map((l) => (l.id === 'b2' ? { ...l, text: 'Built and ran Go indexing services at scale.' } : l))
    const after = buildMatch(noisy, edited, first, meta)
    expect(after.requirements.map((r) => [r.id, r.level])).toEqual([
      ['r1', 'strong'],
      ['r2', 'strong'],
      ['r3', 'missing'],
    ])
    expect(after.requirements[0]!.evidence[0]!.text).toBe('Built and ran Go indexing services at scale.')
  })

  test('a new line can lift a missing requirement once the check cites it', () => {
    const first = buildMatch(out([{ short: 'Rust', level: 'missing' }]), lines, null, meta)
    const added = [...lines, { id: 'b3', text: 'Wrote the Rust indexer.' }]
    const again = buildMatch(out([{ id: 'r1', short: 'Rust', level: 'strong', lines: ['b3'] }]), added, first, meta)
    expect(again.requirements[0]).toMatchObject({ level: 'strong', evidence: [{ lineId: 'b3' }] })
    expect(again.breakdown).toEqual([expect.objectContaining({ criterion: 'skills', points: 100, gaps: [] })])
  })
})

describe('withStoredScore', () => {
  test("rewrites the pass's after-score to the stored one, or adds it", () => {
    const m = { score: 79, resumeVersion: '7' }
    expect(withStoredScore('match 64 -> 82; questions: none', m)).toBe('match 64 -> 79; questions: none')
    expect(withStoredScore('Match 81 → 81/100. Done.', m)).toBe('Match 81 → 79/100. Done.')
    expect(withStoredScore('Package saved.', m)).toBe('Package saved.\nMatch: 79/100.')
  })
})

describe('setResumeMatch', () => {
  test('stores the check without counting as activity', () => {
    const a = createApplication({ companyName: 'Acme', role: 'EM' })
    const before = updateApplication(a.id, { notesMd: 'x' })!.lastActivityAt
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2'] }]), resumeLines(RESUME), null, meta)
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
    const m = buildMatch(out([{ short: 'Go', level: 'strong', lines: ['b2'] }, { short: 'Rust', level: 'missing' }]), resumeLines(RESUME), null, { ...meta, doc: 'main' })
    const r = matchForAgent(setResumeMatch(a.id, m)!)!
    expect(r).toMatchObject({ score: 50, rubricVersion: 2, doc: 'main', resumeChangedSince: true, previousScore: null, noiseMargin: 3 })
    expect(r.breakdown).toEqual([{ criterion: 'skills', label: 'Must-have skills', points: 50, max: 100, gaps: [{ id: 'r2', short: 'Rust', level: 'missing', lost: 50 }] }])
    expect(r.requirements).toMatchObject([
      { id: 'r1', short: 'Go', level: 'strong', lines: ['b2'] },
      { id: 'r2', short: 'Rust', level: 'missing', lines: [] },
    ])
  })

  test('checks from before rubric v2 stay readable, with their stored score', () => {
    const a = createApplication({ companyName: 'Acme', role: 'EM' })
    const old = { ...meta, doc: 'main', score: 77, summary: 'old', requirements: [{ id: 'r1', kind: 'must' as const, short: 'Go', quote: 'Go', level: 'partial' as const, evidence: [], note: '', fix: null }] }
    const r = matchForAgent(setResumeMatch(a.id, old)!)!
    expect(r).toMatchObject({ score: 77, rubricVersion: 1, scoreChange: null, requirements: [{ id: 'r1', area: null }] })
    expect(r.breakdown).toMatch(/before rubric v2/)
  })
})
