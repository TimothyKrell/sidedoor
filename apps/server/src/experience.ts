import { createHash } from 'node:crypto'
import { getDoc } from './services/documents'

/**
 * The Experience document as agents get it in their prompt, so the facts reach them whether or
 * not they page through `get_profile_doc`. The whole document when it fits the budget; otherwise
 * the opening, the newest sections, and the sections that best match the posting (ones marked
 * confirmed count extra), with the rest listed by offset so the agent can read them.
 */

/** Characters of Experience a prep or match prompt carries (about 16K tokens). */
export const EXPERIENCE_BUDGET = 64_000

export interface ExperienceSection {
  heading: string
  /** Where the heading starts in the document (an offset for get_profile_doc). */
  offset: number
  chars: number
  /** Why it was supplied: the whole document fit, it opens the document, it's at the end, or it matches the posting. */
  why?: 'all' | 'intro' | 'newest' | 'match'
  /** The posting's terms it matched. */
  terms?: string[]
}

export interface ExperienceContext {
  /** Ready to paste into a prompt. */
  text: string
  full: boolean
  totalChars: number
  /** Short hash of the document, to tell which version a run saw. */
  version: string
  supplied: ExperienceSection[]
  omitted: ExperienceSection[]
}

interface Chunk extends ExperienceSection {
  level: number
  body: string
  /** Index of the enclosing heading's chunk, to keep a subsection's context. */
  parent: number | null
}

/** Split at markdown headings (# to ####); text before the first heading is its own chunk. */
const chunksOf = (doc: string): Chunk[] => {
  const out: Chunk[] = []
  const stack: number[] = []
  let at = 0
  let cur: Chunk | null = null
  for (const line of doc.split(/(?<=\n)/)) {
    const m = /^(#{1,4})\s+\S/.exec(line)
    if (m || !cur) {
      const level = m ? m[1]!.length : 0
      while (stack.length && out[stack[stack.length - 1]!]!.level >= level) stack.pop()
      cur = { heading: m ? line.trim() : '(top of document)', offset: at, chars: 0, level, body: '', parent: stack.length ? stack[stack.length - 1]! : null }
      out.push(cur)
      if (m) stack.push(out.length - 1)
    }
    cur.body += line
    cur.chars += line.length
    at += line.length
  }
  return out
}

const STOP = new Set(
  `a about above across after again all also am an and any are as at be been being both but by can could did do does doing each etc for from further had has have having he her here hers him his how i if in into is it its just like may me more most must my no nor not of off on once only or other our ours out over own per same she should so some such than that the their them then there these they this those through to too under until up us very via was we well were what when where which while who whom why will with within without would you your yours
  able ability across apply candidate candidates company role roles team teams work working job position opportunity experience experienced years year strong excellent great good new including include includes help helping using use used make build building plus preferred required requirements responsibilities qualifications ideal looking join want engineer engineers engineering software senior based best every first one two three high level time part full`.split(/\s+/),
)

/** Words and tech terms (c++, node.js, ci/cd) worth matching between a posting and a section. */
const termsOf = (s: string) => {
  const out = new Set<string>()
  for (const m of s.toLowerCase().matchAll(/[a-z0-9][a-z0-9+#./-]*/g)) {
    const t = m[0].replace(/[./-]+$/, '')
    if (t.length < 2 || STOP.has(t) || /^\d+$/.test(t)) continue
    out.add(t)
  }
  return out
}

const CONFIRMED = /confirm|verified|correction|update/i

const fmt = (n: number) => n.toLocaleString('en-US')

export const experienceVersion = (body: string) => createHash('sha1').update(body).digest('hex').slice(0, 10)

/**
 * Pick what of `doc` to show for a posting (`about`: its title and description) within `budget`
 * characters. Newer sections win over older lines that disagree, so the end of the document is
 * always included first.
 */
export const selectExperience = (doc: string, about = '', budget = EXPERIENCE_BUDGET): ExperienceContext => {
  const version = experienceVersion(doc)
  const all = chunksOf(doc)
  const strip = (c: Chunk): ExperienceSection => ({ heading: c.heading, offset: c.offset, chars: c.chars, ...(c.why ? { why: c.why } : {}), ...(c.terms?.length ? { terms: c.terms } : {}) })
  const head = `Experience document (version ${version}, ${fmt(doc.length)} characters). It grows at the end: where a later section disagrees with an earlier line, the later section is right.`
  if (doc.length <= budget) {
    for (const c of all) c.why = 'all'
    return { text: `${head} This is all of it.\n\n${doc}`, full: true, totalChars: doc.length, version, supplied: all.map(strip), omitted: [] }
  }

  const picked = new Set<number>()
  let used = 0
  const take = (i: number, why: NonNullable<Chunk['why']>, terms?: string[]) => {
    const c = all[i]!
    if (picked.has(i) || used + c.chars > budget) return false
    picked.add(i)
    used += c.chars
    c.why = why
    if (terms) c.terms = terms
    return true
  }

  // The opening (summary, usually the current role): up to 20% of the budget, from the top down.
  for (let i = 0; i < all.length && used + all[i]!.chars <= budget * 0.2; i++) take(i, 'intro')
  // The newest sections: up to another 40%, from the end back.
  const newestUpTo = used + budget * 0.4
  for (let i = all.length - 1; i > 0 && used < newestUpTo; i--) if (!picked.has(i) && !take(i, 'newest')) break
  // The rest by how well they match the posting: shared terms, rarer ones in the document count more,
  // and sections that record confirmed or corrected facts count extra.
  const want = termsOf(about)
  const chunkTerms = all.map((c) => termsOf(c.body))
  const df = new Map<string, number>()
  for (const ts of chunkTerms) for (const t of ts) if (want.has(t)) df.set(t, (df.get(t) ?? 0) + 1)
  const scored = all
    .map((c, i) => {
      const hits = [...chunkTerms[i]!].filter((t) => want.has(t))
      const score = ((CONFIRMED.test(c.heading) ? 1.5 : 1) * hits.reduce((s, t) => s + Math.log(1 + all.length / (df.get(t) ?? 1)), 0)) / Math.sqrt(Math.max(1, c.chars / 1500))
      return { i, score, hits: hits.sort((x, y) => (df.get(x) ?? 0) - (df.get(y) ?? 0)) }
    })
    .filter((x) => x.score > 0 && !picked.has(x.i))
    .sort((x, y) => y.score - x.score)
  for (const x of scored) take(x.i, 'match', x.hits.slice(0, 8))

  // In document order; a subsection shown without its parent keeps the parent's heading for context.
  const parts: string[] = []
  const shownHeadings = new Set<number>()
  const ancestors = (i: number) => {
    const out: number[] = []
    for (let p = all[i]!.parent; p != null; p = all[p]!.parent) out.unshift(p)
    return out
  }
  for (let i = 0; i < all.length; i++) {
    if (!picked.has(i)) continue
    for (const p of ancestors(i)) {
      if (picked.has(p) || shownHeadings.has(p)) continue
      shownHeadings.add(p)
      parts.push(`${all[p]!.heading}\n(section starts at offset ${all[p]!.offset}; only the part below is included)\n`)
    }
    parts.push(all[i]!.body.replace(/\s*$/, '\n'))
  }
  const omitted = all.filter((_, i) => !picked.has(i))
  const list = omitted.map((c) => `- ${c.heading} (offset ${c.offset}, ${fmt(c.chars)} characters)`).join('\n')
  const text = `${head} It is too long to include whole, so this has ${picked.size} of its ${all.length} sections (${fmt(used)} characters): the opening, the newest sections, and those closest to this posting. Before saying they lack something the posting asks for, read the sections left out that might cover it with get_profile_doc 'experience' and that offset.\n\n${parts.join('\n')}\n## Sections not included above\n${list}\n`
  return { text, full: false, totalChars: doc.length, version, supplied: all.filter((_, i) => picked.has(i)).map(strip), omitted: omitted.map(strip) }
}

/** The user's Experience document for a prompt about a posting. */
export const experienceContext = (about = '', budget = EXPERIENCE_BUDGET) => selectExperience(getDoc('experience').body, about, budget)

/** One line for a task's log: which version and sections the agent was given. */
export const experienceLogLine = (c: ExperienceContext) =>
  c.full
    ? `Experience supplied: the whole document (version ${c.version}, ${fmt(c.totalChars)} characters, ${c.supplied.length} sections)`
    : `Experience supplied: ${c.supplied.length} of ${c.supplied.length + c.omitted.length} sections (version ${c.version}, ${fmt(c.supplied.reduce((s, x) => s + x.chars, 0))} of ${fmt(c.totalChars)} characters): ${c.supplied
        .map((s) => `${s.heading} [${s.why}${s.terms?.length ? `: ${s.terms.join(', ')}` : ''}]`)
        .join('; ')}. Left out: ${c.omitted.map((s) => `${s.heading} @${s.offset}`).join('; ') || 'none'}`
