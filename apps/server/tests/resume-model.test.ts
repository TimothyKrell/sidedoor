import { describe, expect, test } from 'vitest'
import { diffResume, emptyResume, insertLineAfter, keepChange, normalizeContent, type ResumeContent, removeLine, resumeLines, setLine, undoChange } from '@sidedoor/shared/resume'
import { renderResume, sanitizeInline, THEMES } from '@sidedoor/shared/resume-themes'
import { parseLegacyResume } from '../src/legacy/resume-html'

const sample = (): ResumeContent =>
  normalizeContent({
    version: 1,
    basics: { name: 'Ada Example', headline: { id: 'h1', text: 'Staff Engineer' }, location: 'Philadelphia, PA', email: 'ada@example.com', phone: '', links: [{ label: 'LinkedIn', url: 'https://linkedin.com/in/ada' }] },
    highlights: [{ id: 's1', value: '$40M', label: 'ARR grown' }],
    sections: [
      { id: 'sec1', type: 'summary', title: 'Summary', text: { id: 'sum1', text: 'Builds payment systems.' } },
      { id: 'sec2', type: 'experience', title: 'Experience', companies: [{ id: 'co1', name: 'Acme', roles: [{ id: 'r1', title: 'Staff Engineer', dates: '2021 – Present', bullets: [{ id: 'b1', text: 'Cut checkout latency 40%.' }, { id: 'b2', text: 'Led the ledger rewrite.' }] }] }] },
      { id: 'sec3', type: 'skills', title: 'Skills', groups: [{ id: 'sk1', label: 'Languages', text: 'TypeScript, Go' }] },
    ],
  })

describe('resume lines', () => {
  test('every line has a stable id and edits keep it', () => {
    const c = sample()
    const ids = resumeLines(c).map((l) => l.id)
    expect(ids).toEqual(['h1', 's1', 'sec1', 'sum1', 'sec2', 'co1', 'r1', 'b1', 'b2', 'sec3', 'sk1'])
    const next = setLine(c, 'b1', 'Cut checkout latency <strong>40%</strong>.')
    expect(resumeLines(next).map((l) => l.id)).toEqual(ids)
    expect(resumeLines(next).find((l) => l.id === 'b1')?.text).toBe('Cut checkout latency 40%.')
  })

  test('compound lines take their parts', () => {
    const c = setLine(setLine(sample(), 'sk1', '<strong>Tools:</strong> Postgres, Kafka'), 'r1', 'Principal Engineer · 2023 – Present')
    const sec = c.sections[2] as Extract<ResumeContent['sections'][number], { type: 'skills' }>
    expect(sec.groups[0]).toMatchObject({ label: 'Tools', text: 'Postgres, Kafka' })
    const role = (c.sections[1] as Extract<ResumeContent['sections'][number], { type: 'experience' }>).companies[0]!.roles[0]!
    expect(role).toMatchObject({ title: 'Principal Engineer', dates: '2023 – Present' })
  })

  test('normalize gives ids to new lines and fixes duplicates', () => {
    const c = sample()
    const exp = c.sections[1] as Extract<ResumeContent['sections'][number], { type: 'experience' }>
    exp.companies[0]!.roles[0]!.bullets.push({ id: '', text: 'new' }, { id: 'b1', text: 'dup' })
    const ids = resumeLines(normalizeContent(c)).map((l) => l.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('reviewing agent edits', () => {
  test('changes are listed in order, kept, and undone line by line', () => {
    const base = sample()
    let cur = setLine(base, 'b1', 'Cut checkout latency 45%.')
    const added = insertLineAfter(cur, 'b2', 'Mentored four engineers.')
    cur = removeLine(added.content, 'sk1')
    expect(diffResume(base, cur).map((c) => [c.id, c.kind])).toEqual([
      ['b1', 'changed'],
      [added.id, 'added'],
      ['sk1', 'removed'],
    ])
    // Keep the edit: the review base takes it; the rest stay pending.
    const reviewed = keepChange(base, cur, 'b1')
    expect(diffResume(reviewed, cur).map((c) => c.id)).toEqual([added.id, 'sk1'])
    // Undo the addition and the removal: back to the reviewed copy for those lines.
    let undone = undoChange(reviewed, cur, added.id)
    undone = undoChange(reviewed, undone, 'sk1')
    expect(diffResume(reviewed, undone)).toEqual([])
  })

  test('an empty resume has no pending changes against itself', () => {
    const e = emptyResume({ name: 'New Person' })
    expect(diffResume(e, e)).toEqual([])
  })
})

describe('rendering', () => {
  test('every theme renders every line with its id, and only safe inline markup', () => {
    const c = setLine(sample(), 'b2', 'Led the <em>ledger</em> rewrite <script>alert(1)</script><img src=x onerror=alert(1)>')
    for (const t of THEMES) {
      const html = renderResume(c, t.id)
      for (const l of resumeLines(c)) expect(html, `${t.id} ${l.id}`).toContain(`data-id="${l.id}"`)
      expect(html).not.toContain('<script>alert')
      expect(html).not.toMatch(/<img/i)
    }
    expect(sanitizeInline('<a href="javascript:alert(1)">x</a><b onclick="x">y</b>')).toBe('<a>x</a><b>y</b>')
  })
})

test('legacy template resumes parse with their line ids', () => {
  const html = `<!doctype html><html><body><header><h1>Ada Example</h1><div class="positioning" data-id="pos1">Staff Engineer · Payments</div>
    <div class="contact">Philadelphia, PA<span class="sep">◆</span>555-010-0199<span class="sep">◆</span><a href="mailto:ada@example.com">ada@example.com</a><br><a href="https://linkedin.com/in/ada">linkedin.com/in/ada</a></div></header>
    <div class="stats"><div class="stat" data-id="stat1"><span class="stat-num">$40M</span><span class="stat-label">ARR grown</span></div></div>
    <section><h2>Executive Profile</h2><p class="summary" data-id="summary1">Builds payment systems.</p></section>
    <section><h2>Professional Experience</h2><article class="company"><div class="company-line"><span data-id="head1">Acme</span><span class="location">Remote</span></div>
      <div class="role"><div class="role-line"><span data-id="head2">Staff Engineer</span><span class="dates">2021 - Present</span></div><ul><li data-id="b1">Cut latency 40%.</li></ul></div></article></section>
    <main class="page-break"><section><h2>Professional Experience, Continued</h2><article class="company"><div class="company-line"><span data-id="head3">Beta</span></div>
      <div class="role"><div class="role-line"><span data-id="head4">Engineer</span><span class="dates">2018 - 2021</span></div><ul><li data-id="b2">Shipped things.</li></ul></div></article></section></main>
    <section class="skills"><h2>Skills</h2><p data-id="skill1"><strong>Languages:</strong> TypeScript, Go</p></section></body></html>`
  const c = parseLegacyResume(html)!
  expect(c.basics).toMatchObject({ name: 'Ada Example', email: 'ada@example.com', phone: '555-010-0199', location: 'Philadelphia, PA' })
  expect(c.sections.map((s) => s.type)).toEqual(['summary', 'experience', 'skills'])
  const exp = c.sections[1] as Extract<ResumeContent['sections'][number], { type: 'experience' }>
  expect(exp.companies.map((co) => [co.id, co.pageBreakBefore ?? false])).toEqual([
    ['head1', false],
    ['head3', true],
  ])
  expect(resumeLines(c).map((l) => l.id)).toEqual(expect.arrayContaining(['pos1', 'stat1', 'summary1', 'head1', 'head2', 'b1', 'head3', 'b2', 'skill1']))
})

test('the inline sanitizer turns anything that is not a complete allowed tag into text', () => {
  const cases: Array<[string, string]> = [
    ['Led team <img src=x onerror=alert(1) ', 'Led team &lt;img src=x onerror=alert(1) '],
    ['<img src=x onerror=alert(1)>', '&lt;img src=x onerror=alert(1)&gt;'],
    ['<img src="x" onerror="alert(1)">', ''],
    ['a <script>alert(1)</script> b', 'a alert(1) b'],
    ['<b onclick="x">bold</b> <em>it</em>', '<b>bold</b> <em>it</em>'],
    ['<a href="javascript:alert(1)">x</a>', '<a>x</a>'],
    ['<a href="https://ex.com/a?b=1&c=2">x</a>', '<a href="https://ex.com/a?b=1&amp;c=2">x</a>'],
    ['5 < 7 and 9 > 3', '5 &lt; 7 and 9 &gt; 3'],
    ['<span class="note" style="x">(Series B)</span>', '<span class="note">(Series B)</span>'],
    ['<svg><script>alert(1)</script></svg>', 'alert(1)'],
  ]
  for (const [input, want] of cases) expect(sanitizeInline(input), input).toBe(want)
})
