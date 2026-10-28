// Structured resume content. Themes (resume-themes.ts) render it to an HTML document; the editor,
// notes, the review of agent edits, and the match check all work on its lines, which keep stable
// ids across edits. A "line" is any piece of text a person would edit on its own: the headline, a
// highlight, a bullet, a role title, a skill group.

export interface ResumeLink {
  label: string
  url: string
}

/** Inline HTML: text plus <strong>, <em>, <b>, <i>, <a href>, <span class>, <br>. */
export interface Line {
  id: string
  text: string
}

export interface ResumeBasics {
  name: string
  headline: Line | null
  location: string
  email: string
  phone: string
  links: ResumeLink[]
}

/** Big-number strip under the header ("$33B+ / DEX trading volume"). Optional. */
export interface Highlight {
  id: string
  value: string
  label: string
}

export interface Role {
  id: string
  title: string
  dates: string
  location?: string
  bullets: Line[]
}

export interface Company {
  id: string
  /** Inline HTML; may carry a short note, e.g. `Acme <span class="note">(Series B)</span>`. */
  name: string
  location?: string
  /** Start a new page before this company when printing. */
  pageBreakBefore?: boolean
  roles: Role[]
}

export interface SkillGroup {
  id: string
  label: string
  text: string
}

export interface Education {
  id: string
  school: string
  degree: string
  dates?: string
  detail?: string
}

interface SectionBase {
  id: string
  title: string
}
export type Section =
  | (SectionBase & { type: 'summary'; text: Line })
  | (SectionBase & { type: 'experience'; companies: Company[] })
  | (SectionBase & { type: 'skills'; groups: SkillGroup[] })
  | (SectionBase & { type: 'education'; items: Education[] })
  | (SectionBase & { type: 'list'; items: Line[] })
export type SectionType = Section['type']

export interface ResumeContent {
  version: 1
  basics: ResumeBasics
  highlights: Highlight[]
  sections: Section[]
}

export type PaperSize = 'letter' | 'a4'
export interface ThemeOptions {
  accent?: string
  paper?: PaperSize
  /** 0.85–1.15; scales type and spacing so a resume can be fit to a page count. */
  scale?: number
  showHighlights?: boolean
}

/** A note on a resume line, from the user, answered by an agent (the "Ask your AI" flow). */
export interface ResumeNote {
  id: string
  target: string | null
  quote: string
  status: 'open' | 'answered' | 'applied' | 'resolved'
  thread: Array<{ who: 'user' | 'agent'; text: string; at: string }>
  suggestions?: string[]
}

// ------------------------------------------------------------------------------------- ids

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'
export const newLineId = (prefix = 'l') => {
  let s = prefix
  for (let i = 0; i < 7; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  return s
}

// ------------------------------------------------------------------------------------- lines

export type LineKind = 'headline' | 'highlight' | 'heading' | 'summary' | 'company' | 'role' | 'bullet' | 'skill' | 'education' | 'item'

export interface LineInfo {
  id: string
  kind: LineKind
  /** Inline HTML as stored. */
  html: string
  /** Plain text, whitespace collapsed. */
  text: string
  /** Where it sits, for agents and the review list: "Experience › Acme › Staff Engineer". */
  path: string
}

export const stripTags = (html: string) =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&rarr;/g, '→')
    .replace(/\s+/g, ' ')
    .trim()

const highlightHtml = (h: Highlight) => `${h.value} ${h.label}`
const educationHtml = (e: Education) => [e.degree, e.school, e.dates, e.detail].filter(Boolean).join(' · ')
const skillHtml = (g: SkillGroup) => (g.label ? `<strong>${g.label}:</strong> ${g.text}` : g.text)
const roleHtml = (r: Role) => [r.title, r.dates].filter(Boolean).join(' · ')

/** Every line in document order. */
export function resumeLines(c: ResumeContent): LineInfo[] {
  const out: LineInfo[] = []
  const push = (id: string, kind: LineKind, html: string, path: string) => out.push({ id, kind, html, text: stripTags(html), path })
  if (c.basics.headline) push(c.basics.headline.id, 'headline', c.basics.headline.text, 'Header')
  for (const h of c.highlights) push(h.id, 'highlight', highlightHtml(h), 'Highlights')
  for (const s of c.sections) {
    push(s.id, 'heading', s.title, s.title)
    switch (s.type) {
      case 'summary':
        push(s.text.id, 'summary', s.text.text, s.title)
        break
      case 'experience':
        for (const co of s.companies) {
          const coName = stripTags(co.name)
          push(co.id, 'company', co.name, `${s.title} › ${coName}`)
          for (const r of co.roles) {
            push(r.id, 'role', roleHtml(r), `${s.title} › ${coName}`)
            for (const b of r.bullets) push(b.id, 'bullet', b.text, `${s.title} › ${coName} › ${r.title}`)
          }
        }
        break
      case 'skills':
        for (const g of s.groups) push(g.id, 'skill', skillHtml(g), s.title)
        break
      case 'education':
        for (const e of s.items) push(e.id, 'education', educationHtml(e), s.title)
        break
      case 'list':
        for (const i of s.items) push(i.id, 'item', i.text, s.title)
        break
    }
  }
  return out
}

/** Plain-text resume, for prompts and the match check: one line per entry, prefixed with its id. */
export function resumeAsText(c: ResumeContent, withIds = true): string {
  const head = [c.basics.name, [c.basics.location, c.basics.email, c.basics.phone, ...c.basics.links.map((l) => l.url)].filter(Boolean).join(' | ')]
  const body = resumeLines(c).map((l) => {
    const t = l.kind === 'heading' ? `\n## ${l.text}` : l.kind === 'company' ? `\n### ${l.text}` : l.kind === 'bullet' || l.kind === 'item' ? `- ${l.text}` : l.text
    return withIds && l.kind !== 'heading' ? `[${l.id}] ${t.trim()}` : t
  })
  return [...head, ...body].join('\n')
}

// ------------------------------------------------------------------------------------- edits

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Find the object that owns a line id, with its parent list (for removal/insertion). */
type Owner =
  | { kind: 'headline' }
  | { kind: 'highlight'; list: Highlight[]; index: number }
  | { kind: 'heading'; section: Section }
  | { kind: 'summary'; section: Extract<Section, { type: 'summary' }> }
  | { kind: 'company'; list: Company[]; index: number }
  | { kind: 'role'; list: Role[]; index: number }
  | { kind: 'bullet'; list: Line[]; index: number }
  | { kind: 'skill'; list: SkillGroup[]; index: number }
  | { kind: 'education'; list: Education[]; index: number }
  | { kind: 'item'; list: Line[]; index: number }

function findOwner(c: ResumeContent, id: string): Owner | null {
  if (c.basics.headline?.id === id) return { kind: 'headline' }
  const hi = c.highlights.findIndex((h) => h.id === id)
  if (hi >= 0) return { kind: 'highlight', list: c.highlights, index: hi }
  for (const s of c.sections) {
    if (s.id === id) return { kind: 'heading', section: s }
    if (s.type === 'summary' && s.text.id === id) return { kind: 'summary', section: s }
    if (s.type === 'experience') {
      for (let i = 0; i < s.companies.length; i++) {
        const co = s.companies[i]!
        if (co.id === id) return { kind: 'company', list: s.companies, index: i }
        for (let j = 0; j < co.roles.length; j++) {
          const r = co.roles[j]!
          if (r.id === id) return { kind: 'role', list: co.roles, index: j }
          const b = r.bullets.findIndex((x) => x.id === id)
          if (b >= 0) return { kind: 'bullet', list: r.bullets, index: b }
        }
      }
    }
    if (s.type === 'skills') {
      const i = s.groups.findIndex((g) => g.id === id)
      if (i >= 0) return { kind: 'skill', list: s.groups, index: i }
    }
    if (s.type === 'education') {
      const i = s.items.findIndex((e) => e.id === id)
      if (i >= 0) return { kind: 'education', list: s.items, index: i }
    }
    if (s.type === 'list') {
      const i = s.items.findIndex((e) => e.id === id)
      if (i >= 0) return { kind: 'item', list: s.items, index: i }
    }
  }
  return null
}

/**
 * Set a line's text. For simple lines (headline, summary, bullet, list item) `html` replaces the
 * text. Compound lines take their parts: a skill line "<strong>Label:</strong> text", a highlight
 * "value label" (first word is the value), a role "Title · Dates".
 */
export function setLine(content: ResumeContent, id: string, html: string): ResumeContent {
  const c = clone(content)
  const o = findOwner(c, id)
  if (!o) throw new Error(`No resume line with id ${id}`)
  const t = html.trim()
  switch (o.kind) {
    case 'headline':
      c.basics.headline = { id, text: t }
      break
    case 'heading':
      o.section.title = stripTags(t)
      break
    case 'summary':
      o.section.text = { id, text: t }
      break
    case 'bullet':
    case 'item':
      o.list[o.index] = { id, text: t }
      break
    case 'company':
      o.list[o.index]!.name = t
      break
    case 'role': {
      const [title, ...rest] = stripTags(t).split(' · ')
      o.list[o.index]!.title = title ?? ''
      if (rest.length) o.list[o.index]!.dates = rest.join(' · ')
      break
    }
    case 'skill': {
      const m = t.match(/^\s*<(?:strong|b)>(.*?):?\s*<\/(?:strong|b)>:?\s*([\s\S]*)$/i)
      if (m) {
        o.list[o.index]!.label = stripTags(m[1] ?? '').replace(/:$/, '')
        o.list[o.index]!.text = (m[2] ?? '').trim()
      } else o.list[o.index]!.text = t
      break
    }
    case 'highlight': {
      const plain = stripTags(t)
      const sp = plain.indexOf(' ')
      o.list[o.index] = sp > 0 ? { id, value: plain.slice(0, sp), label: plain.slice(sp + 1) } : { id, value: plain, label: '' }
      break
    }
    case 'education': {
      const parts = stripTags(t).split(' · ')
      const e = o.list[o.index]!
      e.degree = parts[0] ?? ''
      if (parts[1] !== undefined) e.school = parts[1]
      if (parts[2] !== undefined) e.dates = parts[2]
      if (parts[3] !== undefined) e.detail = parts[3]
      break
    }
  }
  return c
}

/** Add a bullet/list item after an existing line (or at the end of a role/list when `after` is its parent id). */
export function insertLineAfter(content: ResumeContent, after: string, html: string, id = newLineId('n')): { content: ResumeContent; id: string } {
  const c = clone(content)
  const o = findOwner(c, after)
  if (!o) throw new Error(`No resume line with id ${after}`)
  if (o.kind === 'bullet' || o.kind === 'item') o.list.splice(o.index + 1, 0, { id, text: html })
  else if (o.kind === 'role') o.list[o.index]!.bullets.unshift({ id, text: html })
  else if (o.kind === 'heading' && o.section.type === 'list') o.section.items.unshift({ id, text: html })
  else if (o.kind === 'skill') o.list.splice(o.index + 1, 0, { id, label: '', text: html })
  else throw new Error(`Can't add a line after a ${o.kind}; add bullets after a bullet or a role`)
  return { content: c, id }
}

export function removeLine(content: ResumeContent, id: string): ResumeContent {
  const c = clone(content)
  const o = findOwner(c, id)
  if (!o) return c
  if ('list' in o) o.list.splice(o.index, 1)
  else if (o.kind === 'headline') c.basics.headline = null
  else if (o.kind === 'heading') c.sections = c.sections.filter((s) => s.id !== id)
  else throw new Error(`Can't remove a ${o.kind} line`)
  return c
}

/** Move a bullet up/down within its role (or an item within its list). */
export function moveLine(content: ResumeContent, id: string, delta: -1 | 1): ResumeContent {
  const c = clone(content)
  const o = findOwner(c, id)
  if (!o || !('list' in o)) return c
  const to = o.index + delta
  if (to < 0 || to >= o.list.length) return c
  const list = o.list as unknown[]
  const [x] = list.splice(o.index, 1)
  list.splice(to, 0, x)
  return c
}

/**
 * Give every line an id, and fresh ids to duplicates. Run on anything an agent or an import
 * hands us, so the editor and the review always have ids to work with.
 */
export function normalizeContent(input: ResumeContent): ResumeContent {
  const c = clone(input)
  const seen = new Set<string>()
  const fix = <T extends { id: string }>(o: T, prefix: string) => {
    if (!o.id || seen.has(o.id)) o.id = newLineId(prefix)
    seen.add(o.id)
    return o
  }
  c.version = 1
  c.basics ??= { name: '', headline: null, location: '', email: '', phone: '', links: [] }
  c.basics.links ??= []
  if (c.basics.headline) fix(c.basics.headline, 'h')
  c.highlights = (c.highlights ?? []).map((h) => fix(h, 's'))
  c.sections = (c.sections ?? []).map((s) => {
    fix(s, 'sec')
    if (s.type === 'summary') fix(s.text, 'sum')
    if (s.type === 'experience')
      s.companies = (s.companies ?? []).map((co) => {
        fix(co, 'co')
        co.roles = (co.roles ?? []).map((r) => {
          fix(r, 'r')
          r.bullets = (r.bullets ?? []).map((b) => fix(b, 'b'))
          return r
        })
        return co
      })
    if (s.type === 'skills') s.groups = (s.groups ?? []).map((g) => fix(g, 'sk'))
    if (s.type === 'education') s.items = (s.items ?? []).map((e) => fix(e, 'ed'))
    if (s.type === 'list') s.items = (s.items ?? []).map((i) => fix(i, 'li'))
    return s
  })
  return c
}

export const emptyResume = (basics: Partial<ResumeBasics> = {}): ResumeContent =>
  normalizeContent({
    version: 1,
    basics: { name: '', headline: { id: '', text: '' }, location: '', email: '', phone: '', links: [], ...basics },
    highlights: [],
    sections: [
      { id: '', type: 'summary', title: 'Summary', text: { id: '', text: '' } },
      { id: '', type: 'experience', title: 'Experience', companies: [] },
      { id: '', type: 'skills', title: 'Skills', groups: [] },
      { id: '', type: 'education', title: 'Education', items: [] },
    ],
  })

// ------------------------------------------------------------------------------------- review

export interface LineChange {
  id: string
  kind: 'changed' | 'added' | 'removed'
  lineKind: LineKind
  path: string
  before: string
  after: string
}

/** What changed since the user last reviewed: line by line, in document order. */
export function diffResume(base: ResumeContent | null | undefined, current: ResumeContent): LineChange[] {
  if (!base) return []
  const b = resumeLines(base)
  const cur = resumeLines(current)
  const byId = new Map(b.map((l) => [l.id, l]))
  const curIds = new Set(cur.map((l) => l.id))
  const removedAfter = new Map<string | null, LineInfo[]>()
  let prev: string | null = null
  for (const l of b) {
    if (curIds.has(l.id)) prev = l.id
    else removedAfter.set(prev, [...(removedAfter.get(prev) ?? []), l])
  }
  const out: LineChange[] = []
  const pushRemoved = (after: string | null) => {
    for (const l of removedAfter.get(after) ?? []) out.push({ id: l.id, kind: 'removed', lineKind: l.kind, path: l.path, before: l.text, after: '' })
  }
  pushRemoved(null)
  for (const l of cur) {
    const was = byId.get(l.id)
    if (!was) out.push({ id: l.id, kind: 'added', lineKind: l.kind, path: l.path, before: '', after: l.text })
    else if (was.html.replace(/\s+/g, ' ').trim() !== l.html.replace(/\s+/g, ' ').trim())
      out.push({ id: l.id, kind: 'changed', lineKind: l.kind, path: l.path, before: was.text, after: l.text })
    pushRemoved(l.id)
  }
  return out
}

/** Keep a change: the review base takes the current version of that line. */
export function keepChange(base: ResumeContent, current: ResumeContent, id: string): ResumeContent {
  return transplant(current, base, id)
}

/** Undo a change: the current resume goes back to the reviewed version of that line. */
export function undoChange(base: ResumeContent, current: ResumeContent, id: string): ResumeContent {
  return transplant(base, current, id)
}

/**
 * Make `to` match `from` for one line: copy its text, add it where it sits in `from`, or remove it.
 * Structural lines (company, role, section) move with their children.
 */
function transplant(from: ResumeContent, to: ResumeContent, id: string): ResumeContent {
  const src = findOwner(from, id)
  const dst = findOwner(to, id)
  if (!src && !dst) return to
  if (!src) return removeLine(to, id)
  const fromLine = resumeLines(from).find((l) => l.id === id)!
  if (dst) {
    // Same line on both sides: copy the source object (keeps dates, labels, etc. exact).
    const c = clone(to)
    const d = findOwner(c, id)!
    const s = src
    if (s.kind === 'headline') c.basics.headline = clone(from.basics.headline)
    else if (s.kind === 'heading' && d.kind === 'heading') d.section.title = s.section.title
    else if (s.kind === 'summary' && d.kind === 'summary') d.section.text = clone(s.section.text)
    else if ('list' in s && 'list' in d) {
      const item = clone(s.list[s.index]) as never
      if (s.kind === 'company' || s.kind === 'role') {
        // Only the line itself, not the children (they are reviewed one by one).
        const keepChildren = d.list[d.index] as Company | Role
        const next = item as Company | Role
        if ('roles' in next && 'roles' in keepChildren) next.roles = keepChildren.roles
        if ('bullets' in next && 'bullets' in keepChildren) next.bullets = keepChildren.bullets
      }
      ;(d.list as unknown[])[d.index] = item
    } else return setLine(to, id, fromLine.html)
    return c
  }
  // Line exists only in `from`: insert it after its previous sibling in `from`.
  const c = clone(to)
  if ('list' in src) {
    const prevId = src.index > 0 ? (src.list[src.index - 1] as { id: string }).id : null
    const item = clone(src.list[src.index]) as { id: string }
    // Find the matching parent list in `c` via the previous sibling, else via the parent of `from`.
    if (prevId) {
      const p = findOwner(c, prevId)
      if (p && 'list' in p) {
        ;(p.list as unknown[]).splice(p.index + 1, 0, item)
        return c
      }
    }
    const parentId = parentOf(from, id)
    if (parentId) {
      const pc = findListOwner(c, parentId, src.kind)
      if (pc) {
        pc.unshift(item)
        return c
      }
    }
  }
  if (src.kind === 'headline') c.basics.headline = clone(from.basics.headline)
  if (src.kind === 'heading') {
    const i = from.sections.findIndex((s) => s.id === id)
    c.sections.splice(Math.min(i, c.sections.length), 0, clone(src.section))
  }
  return c
}

function parentOf(c: ResumeContent, id: string): string | null {
  for (const s of c.sections) {
    if (s.type === 'experience')
      for (const co of s.companies) {
        if (co.id === id) return s.id
        for (const r of co.roles) {
          if (r.id === id) return co.id
          if (r.bullets.some((b) => b.id === id)) return r.id
        }
      }
    if ((s.type === 'list' || s.type === 'education') && s.items.some((i) => i.id === id)) return s.id
    if (s.type === 'skills' && s.groups.some((g) => g.id === id)) return s.id
  }
  return null
}

function findListOwner(c: ResumeContent, parentId: string, childKind: LineKind): unknown[] | null {
  for (const s of c.sections) {
    if (s.id === parentId) {
      if (s.type === 'experience' && childKind === 'company') return s.companies
      if ((s.type === 'list' || s.type === 'education') && (childKind === 'item' || childKind === 'education')) return s.items
      if (s.type === 'skills' && childKind === 'skill') return s.groups
    }
    if (s.type === 'experience')
      for (const co of s.companies) {
        if (co.id === parentId && childKind === 'role') return co.roles
        for (const r of co.roles) if (r.id === parentId && childKind === 'bullet') return r.bullets
      }
  }
  return null
}
