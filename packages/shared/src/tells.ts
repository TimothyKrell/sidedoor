// AI-writing tell checker. A TypeScript port of ~/Code/resume/scripts/check-tells.mjs: the rules
// come from tells.json in the resume workspace and scoring is identical (same regex flags, same
// word count, same per-100 rounding). Isomorphic: the server loads the rules, the UI reuses this
// to score and highlight text live.

export interface TellRule {
  id: string
  tell?: number
  weight: number
  label: string
  pattern: string
  flags?: string
  fix: string
}

export interface TellHit {
  id: string
  label: string
  weight: number
  /** Matched text, trimmed (as check-tells.mjs reports it). */
  match: string
  line: number
  fix: string
  /** Character offsets of the trimmed match in the text (for highlighting). */
  start: number
  end: number
}

export interface TellReport {
  words: number
  score: number
  per100: number
  hits: TellHit[]
}

/** Weight at or above which a hit is a real tell to fix (below that it only matters in clusters). */
export const STRONG_WEIGHT = 1

const compiled = new WeakMap<TellRule, RegExp | null>()
const regexFor = (r: TellRule) => {
  if (!compiled.has(r)) {
    try {
      compiled.set(r, new RegExp(r.pattern, r.flags ?? 'gi'))
    } catch {
      // A broken pattern in tells.json shouldn't take the app down; check-tells.mjs would throw.
      compiled.set(r, null)
    }
  }
  const re = compiled.get(r)
  if (!re) return null
  // matchAll needs a global regex; clone so lastIndex state never leaks between calls.
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
}

export function checkTellsWith(rules: readonly TellRule[], text: string): TellReport {
  const hits: TellHit[] = []
  for (const r of rules) {
    const re = regexFor(r)
    if (!re) continue
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0
      const raw = m[0]
      const lead = raw.length - raw.trimStart().length
      const match = raw.trim()
      const line = text.slice(0, index).split('\n').length
      hits.push({ id: r.id, label: r.label, weight: r.weight, match, line, fix: r.fix, start: index + lead, end: index + lead + match.length })
    }
  }
  const words = text.split(/\s+/).filter(Boolean).length || 1
  const score = hits.reduce((s, h) => s + h.weight, 0)
  return { words, score, per100: +((score / words) * 100).toFixed(2), hits }
}

export const strongHits = (r: TellReport) => r.hits.filter((h) => h.weight >= STRONG_WEIGHT)

/** Same HTML reduction as check-tells.mjs. */
export function toText(src: string, isHtml: boolean) {
  if (!isHtml) return src
  return src
    .replace(/<(style|script|svg)[\s\S]*?<\/\1>/gi, '')
    .replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/&quot;/g, '"')
    .replace(/&mdash;/g, '—')
}

/** Short text summary for agents and logs. */
export function describeReport(r: TellReport) {
  const strong = strongHits(r)
  const lines = [`score ${r.score} (${r.per100} per 100 words, ${r.words} words), ${strong.length} strong tell${strong.length === 1 ? '' : 's'} (weight >= ${STRONG_WEIGHT})`]
  for (const h of r.hits) lines.push(`- L${h.line} [${h.label}, weight ${h.weight}] "${h.match}" -> ${h.fix}`)
  return lines.join('\n')
}
