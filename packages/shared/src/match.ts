// Resume ↔ job-description match: what a posting asks for, and the resume line that answers each
// ask. Claude reads the two (src/server/match.ts); this file holds the shape and the scoring,
// shared by the application page and the resume editor.

export const MATCH_LEVELS = ['strong', 'partial', 'weak', 'missing'] as const
export type MatchLevel = (typeof MATCH_LEVELS)[number]

/** One resume line backing a requirement. `text` is the line as it read when the check ran. */
export type MatchEvidence = { lineId: string; short: string; text: string }

/** Which part of the rubric a requirement scores under (must-haves; nice-to-haves all count as 'nice'). */
export const MATCH_AREAS = ['skills', 'scope', 'domain', 'logistics'] as const
export type MatchArea = (typeof MATCH_AREAS)[number]

export type MatchRequirement = {
  /** Stable across re-checks (r1, r2…), so the list doesn't reshuffle when the resume changes. */
  id: string
  kind: 'must' | 'nice'
  /** Rubric area. Missing on checks made before rubric v2. */
  area?: MatchArea
  /** A few words, for scanning. */
  short: string
  /** The posting's own words. */
  quote: string
  level: MatchLevel
  evidence: MatchEvidence[]
  /** Why it got this level. */
  note: string
  /** A true fact from the career inventory that would close the gap, if there is one. */
  fix: string | null
}

/** A requirement that lost points, and how many. */
export type MatchGap = { id: string; short: string; level: MatchLevel; lost: number; note: string; fix: string | null }

/** Points for one rubric criterion; the criteria's points add up to the score. */
export type CriterionScore = { criterion: MatchCriterion; label: string; points: number; max: number; requirements: number; gaps: MatchGap[] }

export type ResumeMatch = {
  at: string
  model: string
  /** Resume editor document the check read ('main' or a tailored folder). */
  doc: string
  /** mtime of the resume HTML when checked, to tell when it changed since. */
  resumeVersion: string
  score: number
  summary: string
  requirements: MatchRequirement[]
  /** Rubric the score was computed with. Missing on checks before v2 (their score stays as stored). */
  rubricVersion?: number
  /** Per-criterion points behind the score (v2+). */
  breakdown?: CriterionScore[]
  /** Fingerprint of rubric + posting + resume lines: an identical re-check reuses this result. */
  inputHash?: string
  /** Fingerprint of the posting, so the requirement list stays frozen while it doesn't change. */
  jdHash?: string
  /** Fingerprint of each resume line when checked, to tell which lines a re-check needs to re-judge. */
  lineHashes?: Record<string, string>
  /** Score of the check this one replaced, for "did that round help?". */
  previousScore?: number | null
}

/**
 * Rubric v2. Each criterion has a fixed point budget; a criterion the posting doesn't ask about
 * hands its budget to the others in proportion. Within a criterion every requirement counts the
 * same and earns its level's credit. The model only judges kind, area and level; the points are
 * computed here, so the arithmetic never wobbles.
 */
export const MATCH_RUBRIC_VERSION = 2
export const MATCH_CRITERIA = ['skills', 'scope', 'domain', 'logistics', 'nice'] as const
export type MatchCriterion = (typeof MATCH_CRITERIA)[number]
export const CRITERION_META: Record<MatchCriterion, { label: string; budget: number }> = {
  skills: { label: 'Must-have skills', budget: 40 },
  scope: { label: 'Seniority and scope', budget: 25 },
  domain: { label: 'Domain', budget: 15 },
  logistics: { label: 'Logistics', budget: 10 },
  nice: { label: 'Nice-to-haves', budget: 10 },
}
/** How much each level earns of a requirement's share. */
export const LEVEL_CREDIT: Record<MatchLevel, number> = { strong: 1, partial: 0.6, weak: 0.25, missing: 0 }
/**
 * A change this small between two checks is judgment noise, not improvement: a loop that raises the
 * score should stop once a round moves it by no more than this.
 */
export const MATCH_NOISE_MARGIN = 3

const one = (n: number) => Math.round(n * 10) / 10
export const criterionOf = (r: Pick<MatchRequirement, 'kind' | 'area'>): MatchCriterion => (r.kind === 'nice' ? 'nice' : (r.area ?? 'skills'))

/** The rubric applied to a set of judged requirements: per-criterion points, lost points, and the score. */
export const scoreMatch = (reqs: Pick<MatchRequirement, 'id' | 'kind' | 'area' | 'short' | 'level' | 'note' | 'fix'>[]): { score: number; breakdown: CriterionScore[] } => {
  const groups = MATCH_CRITERIA.map((c) => ({ c, reqs: reqs.filter((r) => criterionOf(r) === c) })).filter((g) => g.reqs.length)
  const budget = groups.reduce((n, g) => n + CRITERION_META[g.c].budget, 0)
  if (!budget) return { score: 0, breakdown: [] }
  let total = 0
  const breakdown = groups.map(({ c, reqs: rs }): CriterionScore => {
    const max = (100 * CRITERION_META[c].budget) / budget
    const each = max / rs.length
    const points = rs.reduce((n, r) => n + each * LEVEL_CREDIT[r.level], 0)
    total += points
    const gaps = rs.filter((r) => r.level !== 'strong').map((r) => ({ id: r.id, short: r.short, level: r.level, lost: one(each * (1 - LEVEL_CREDIT[r.level])), note: r.note, fix: r.fix }))
    return { criterion: c, label: CRITERION_META[c].label, points: one(points), max: one(max), requirements: rs.length, gaps: gaps.sort((a, b) => b.lost - a.lost) }
  })
  return { score: Math.round(total), breakdown }
}

export const matchScore = (reqs: Pick<MatchRequirement, 'kind' | 'area' | 'level'>[]) => scoreMatch(reqs.map((r, i) => ({ ...r, id: String(i), short: '', note: '', fix: null }))).score

export const levelCounts = (reqs: Pick<MatchRequirement, 'level'>[]) => {
  const c: Record<MatchLevel, number> = { strong: 0, partial: 0, weak: 0, missing: 0 }
  for (const r of reqs) c[r.level]++
  return c
}

export const LEVEL_META: Record<MatchLevel, { label: string; text: string; bg: string; soft: string; border: string; dots: number }> = {
  strong: { label: 'Strong', text: 'text-success', bg: 'bg-success', soft: 'bg-success/10', border: 'border-l-success', dots: 3 },
  partial: { label: 'Partial', text: 'text-info', bg: 'bg-info', soft: 'bg-info/10', border: 'border-l-info', dots: 2 },
  weak: { label: 'Weak', text: 'text-hot', bg: 'bg-hot', soft: 'bg-hot/10', border: 'border-l-hot', dots: 1 },
  missing: { label: 'Missing', text: 'text-destructive', bg: 'bg-destructive', soft: 'bg-destructive/10', border: 'border-l-destructive', dots: 0 },
}

export const scoreTone = (score: number) => (score >= 80 ? 'text-success' : score >= 60 ? 'text-info' : score >= 40 ? 'text-hot' : 'text-destructive')

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rarr: '→', larr: '←', mdash: '—', ndash: '–', middot: '·', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  )

/**
 * The resume's editable lines (elements with data-id) as plain text, in document order. Works on
 * the HTML string so the worker needs no DOM. A line's text includes any nested lines.
 */
export const resumeLines = (html: string): { id: string; text: string }[] => {
  const body = html.replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, '').replace(/<!--[\s\S]*?-->/g, '')
  const out: { id: string; text: string }[] = []
  const open = /<([a-z][a-z0-9]*)\b[^>]*\bdata-id="([^"]+)"[^>]*>/gi
  for (let m = open.exec(body); m; m = open.exec(body)) {
    const tag = m[1]!.toLowerCase()
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi')
    tags.lastIndex = m.index + m[0].length
    let depth = 1
    let end = body.length
    for (let t = tags.exec(body); t; t = tags.exec(body)) {
      depth += t[1] ? -1 : 1
      if (depth === 0) {
        end = t.index
        break
      }
    }
    const inner = body.slice(m.index + m[0].length, end)
    const text = decode(inner.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').replace(/ ([.,;:!?)])/g, '$1').trim()
    if (text) out.push({ id: m[2]!, text })
  }
  return out
}
