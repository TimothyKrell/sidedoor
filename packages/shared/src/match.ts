// Resume ↔ job-description match: what a posting asks for, and the resume line that answers each
// ask. Claude reads the two (src/server/match.ts); this file holds the shape and the scoring,
// shared by the application page and the resume editor.

export const MATCH_LEVELS = ['strong', 'partial', 'weak', 'missing'] as const
export type MatchLevel = (typeof MATCH_LEVELS)[number]

/** One resume line backing a requirement. `text` is the line as it read when the check ran. */
export type MatchEvidence = { lineId: string; short: string; text: string }

export type MatchRequirement = {
  /** Stable across re-checks (r1, r2…), so the list doesn't reshuffle when the resume changes. */
  id: string
  kind: 'must' | 'nice'
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
}

/** How much each level counts toward the score; must-haves weigh double. */
const CREDIT: Record<MatchLevel, number> = { strong: 1, partial: 0.6, weak: 0.25, missing: 0 }
const WEIGHT = { must: 2, nice: 1 } as const

export const matchScore = (reqs: Pick<MatchRequirement, 'kind' | 'level'>[]) => {
  const total = reqs.reduce((n, r) => n + WEIGHT[r.kind], 0)
  if (!total) return 0
  return Math.round((100 * reqs.reduce((n, r) => n + WEIGHT[r.kind] * CREDIT[r.level], 0)) / total)
}

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
