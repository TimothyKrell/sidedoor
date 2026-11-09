/**
 * Which answers a form filler may use without asking the user first. The package is markdown the
 * prep AI writes; this reads the parts that matter for that (the "Application form" table, the
 * "### Q" answers, the "Questions for …" and "Needs your decision" lists, and the answers the user
 * gave through answer_questions) into answers that are confirmed or not, and checks a fill's
 * report against them. Sidedoor runs it after every fill, before it reports "ready" and before
 * any submit click (jobs/fill-form.ts).
 */

import { truncate } from './text'

/** Where a filled value came from, as the filler reports it. */
export const FILL_SOURCES = ['standard_answer', 'package', 'profile', 'resume', 'ai_generated'] as const
export type FillSource = (typeof FILL_SOURCES)[number]

/** Where Sidedoor decided a filled value came from: the filler's word, unless the package or Standard answers say otherwise. */
export type AuditSource = FillSource | 'user_answer' | 'unconfirmed'

export interface AuditEntry {
  /** The form's label for the field. */
  field: string
  value: string
  source: AuditSource
  /** False: the user hasn't confirmed this answer, so it can't go in without asking them. */
  confirmed: boolean
  why?: string
}

export interface PackageAnswer {
  question: string
  answer: string
  source: string
  /** null when the package doesn't say. */
  required: boolean | null
  /** The marker that makes it unconfirmed ("confirm", "default", "inferred"…), or null. */
  flag: string | null
}

export interface PackageReview {
  answers: PackageAnswer[]
  /** Open items under "Questions for …" and "Needs your decision" (ticked ones left out). */
  pending: string[]
  /** What the user answered through answer_questions: confirmed by them. */
  given: { question: string; answer: string }[]
}

/** In a table's Answer or Source cell: the prep AI wasn't sure. */
const FLAG = /\b(confirm|unconfirmed|inferred|infer|default|guess|guessed|todo|tbd|assumed|placeholder)\b/i
/** In a long written answer, where "confirm" can be an ordinary word: only explicit markers. */
const STRONG_FLAG = /\bTODO\b|\bTBD\b|\[[^\]]*\b(confirm|todo|tbd|guess|inferred)\b[^\]]*\]|\([^)]*\b(confirm|inferred|default|guess)\b[^)]*\)/i
const PENDING_HEADING = /^(questions? for\b|open questions|needs your decision)/i
const GIVEN_HEADING = /^(answers to the other form questions|your answers to questions)\b/i

const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export const readPackage = (md: string | null | undefined): PackageReview => {
  const out: PackageReview = { answers: [], pending: [], given: [] }
  let h2 = ''
  let h3: { question: string; body: string[] } | null = null
  let cols: Record<'question' | 'answer' | 'source' | 'required', number> | null = null
  let letter: string[] | null = null
  let lastOpen = false
  const endLetter = () => {
    const body = letter?.join('\n').trim()
    if (body) out.answers.push({ question: 'Cover letter', answer: body, source: '', required: null, flag: body.match(STRONG_FLAG)?.[0] ?? null })
    letter = null
  }
  const endH3 = () => {
    if (!h3) return
    const body = h3.body.join('\n').trim()
    if (GIVEN_HEADING.test(h2)) {
      if (body) out.given.push({ question: h3.question, answer: body })
    } else {
      const m = body.match(STRONG_FLAG)
      out.answers.push({ question: h3.question, answer: body, source: '', required: null, flag: m ? m[0] : null })
    }
    h3 = null
  }
  for (const line of (md ?? '').split('\n')) {
    const head = line.match(/^(#{1,6})\s+(.*)$/)
    if (head) {
      endH3()
      cols = null
      if (head[1]!.length <= 2) {
        endLetter()
        h2 = head[2]!.trim()
        if (/^cover letter/i.test(h2)) letter = []
      }
      else h3 = { question: head[2]!.trim().replace(/^Q\d+\s*[:.)-]?\s*/i, ''), body: [] }
      continue
    }
    if (h3) {
      h3.body.push(line)
      continue
    }
    if (letter) {
      letter.push(line)
      continue
    }
    if (line.trim().startsWith('|')) {
      const c = cells(line)
      if (c.every((x) => /^:?-{2,}:?$/.test(x) || !x)) continue
      if (!cols) {
        const names = c.map((x) => x.toLowerCase())
        const at = (re: RegExp) => names.findIndex((n) => re.test(n))
        cols = { question: at(/question|field/), answer: at(/answer|value/), source: at(/source/), required: at(/required/) }
        if (cols.question < 0 || cols.answer < 0) cols = { question: -1, answer: -1, source: -1, required: -1 }
        continue
      }
      if (cols.question < 0) continue
      const at = cols
      const get = (k: keyof typeof at) => (at[k] >= 0 ? (c[at[k]] ?? '') : '')
      const question = get('question')
      if (!question) continue
      const req = get('required')
      const answer = get('answer')
      const source = get('source')
      const m = `${answer} ${source}`.match(FLAG)
      out.answers.push({ question, answer, source, required: !req ? null : /^(y|yes|required|true)\b/i.test(req), flag: m ? m[0] : null })
      continue
    }
    cols = null
    if (PENDING_HEADING.test(h2)) {
      const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[( |x|X)\]\s*)?(.*)$/)
      if (item) {
        const text = item[2]!.trim()
        // "**Answered …**" is a note, not an item. Indented under a question, it closes that question.
        if (/^\*\*Answered\b/i.test(text)) {
          if (/^\s/.test(line) && lastOpen) out.pending.pop()
          lastOpen = false
          continue
        }
        lastOpen = item[1]?.toLowerCase() !== 'x' && !!text
        if (lastOpen) out.pending.push(text)
      } else if (line.trim() && out.pending.length && /^\s{2,}/.test(line)) out.pending[out.pending.length - 1] += ` ${line.trim()}`
    }
  }
  endH3()
  endLetter()
  return out
}

const STOP = new Set(
  'a an and or the to of for in on at as by be is are was were am do does did done you your yours i me my we our us it its this that these those what which who whom how when where why will would should could can may might have has had been being any all some with from about into than then there their they them if not no yes please form field question questions required optional answer answers select choose one per set should say'.split(
    ' ',
  ),
)

const wordList = (s: string, drop: ReadonlySet<string>) => {
  const all = (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)).map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w))
  const kept = all.filter((w) => !drop.has(w))
  return kept.length ? kept : all
}

/** The words of a label or sentence that say what it's about. */
export const keyWords = (s: string, drop: ReadonlySet<string> = new Set()) => new Set(wordList(s, drop))

/** Most of what `label` is about appears in `text`. */
const covers = (label: Set<string>, text: Set<string>) => label.size > 0 && [...label].filter((w) => text.has(w)).length / label.size >= 0.6

/** Two wordings of the same form question ("How did you first learn about Acme" and "How did you first learn about Acme as an employer?"). */
export const sameQuestion = (a: string, b: string, drop?: ReadonlySet<string>) => {
  const A = keyWords(a, drop)
  const B = keyWords(b, drop)
  return covers(A, B) || covers(B, A)
}

/**
 * The user's answer to `given` confirms this field. Stricter than `sameQuestion`, because it lets a
 * value through: an answer to "Name" doesn't confirm "Emergency contact name". A question of three
 * or more words is specific enough to count inside a longer label.
 */
const confirmsField = (given: string, field: string, drop: ReadonlySet<string>) => {
  const g = keyWords(given, drop)
  const f = keyWords(field, drop)
  return covers(f, g) || (g.size >= 3 && covers(g, f))
}

/** Name, email and phone: only an explicit mark in the package holds these, never a word in an open item ("project name"). */
const CONTACT = /^((full|first|last|legal)\s+)?name$|^e-?mail(\s+address)?$|^(phone|mobile)(\s+number)?$/i
const isContact = (field: string) => CONTACT.test(field.replace(/[*:]/g, '').trim())

/**
 * An open item is about this field. A short label has to appear as a phrase: its words scattered
 * through a sentence ("the first stack the JD names") aren't "First Name".
 */
const mentions = (field: string, item: string, drop: ReadonlySet<string>) => {
  const label = wordList(field, drop)
  if (label.length >= 3) return covers(new Set(label), keyWords(item, drop))
  const words = wordList(item, drop)
  return words.some((_, i) => label.every((w, j) => words[i + j] === w))
}

/** Voluntary self-identification questions, which only an explicit Standard answer (or the user) may answer. */
const DEMOGRAPHIC: { key: string; re: RegExp }[] = [
  { key: 'gender', re: /\bgender|\bsex\b/i },
  { key: 'pronouns', re: /pronoun/i },
  { key: 'transgender', re: /transgender|\btrans\b/i },
  { key: 'orientation', re: /orientation|\blgbt|sexuality/i },
  { key: 'ethnicity', re: /\brace\b|racial|ethnic|hispanic|latin[aox]/i },
  { key: 'veteran', re: /veteran|military|armed forces/i },
  { key: 'disability', re: /disabilit|disabled/i },
]
export const demographicKinds = (label: string) => DEMOGRAPHIC.filter((d) => d.re.test(label)).map((d) => d.key)
export const isDemographic = (label: string) => demographicKinds(label).length > 0

const DECLINE = /\bdecline|don'?t wish|do not wish|prefer not|choose not|not to (answer|say|disclose|self)|rather not|not (wish|want) to/i
const EMPTY = /^\s*(\(.*\)|n\/?a|none|-+|tbd|todo|\?+)?\s*$/i

/**
 * What Standard answers say, as (label, answer) pairs: table rows, "- Label: answer" and
 * "- **Label** answer" lines, with "Gender: Male. Race: White." in an answer split into its own pairs.
 */
export const standardStatements = (doc: string) => {
  const out: { label: string; answer: string }[] = []
  const add = (label: string, answer: string) => {
    const parts = answer.split(/(?<=\.)\s+|;\s+/).map((p) => p.trim()).filter(Boolean)
    const keyed = parts.map((p) => p.match(/^([^:]{2,60}):\s*(.+)$/))
    if (keyed.some(Boolean)) keyed.forEach((m, i) => (m ? out.push({ label: m[1]!.trim(), answer: m[2]!.trim() }) : out.push({ label, answer: parts[i]! })))
    else out.push({ label, answer: answer.trim() })
  }
  for (const line of doc.split('\n')) {
    const t = line.trim()
    if (t.startsWith('|')) {
      const c = cells(t)
      if (c.length >= 2 && !c.every((x) => /^:?-{2,}:?$/.test(x) || !x)) add(c[0]!.replace(/\*/g, ''), c[1]!)
      continue
    }
    const bold = t.match(/^(?:[-*+]\s+)?\*\*(.+?)\*\*:?\s*(.*)$/)
    if (bold) {
      add(bold[1]!.replace(/:$/, ''), bold[2]!)
      continue
    }
    const plain = t.match(/^[-*+]\s+([^:]{2,80}):\s*(.*)$/)
    if (plain) add(plain[1]!, plain[2]!)
  }
  return out.filter((s) => !EMPTY.test(s.answer.replace(/\*\*CONFIRM[^*]*\*\*/gi, '')))
}

/** Forms offer "Man" where Standard answers say "Male". Only the whole answer: "Trans man" isn't "Male". */
const plainSex = (value: string) => value.trim().replace(/^man$/i, 'male').replace(/^woman$/i, 'female')

/** Standard answers say this, in so many words, for this kind of question. */
const explicitlyStandard = (kinds: string[], value: string, statements: { label: string; answer: string }[]) => {
  const v = keyWords(plainSex(value))
  return statements.some((s) => {
    if (!demographicKinds(s.label).some((k) => kinds.includes(k))) return false
    if (/\bconfirm\b/i.test(s.answer)) return false
    if (DECLINE.test(value)) return DECLINE.test(s.answer)
    const a = keyWords(s.answer)
    return covers(v, a) || covers(a, v)
  })
}

export interface FilledField {
  field: string
  value: string
  source?: FillSource
  options?: string[]
}

/** What the user has already dealt with on this application, which the package text may not show yet. */
export interface Settled {
  /** This open item's question was answered or dropped. */
  item: (text: string) => boolean
  /** They said this field needs no question while it held this value. */
  passed: (field: string, value: string) => boolean
}

export interface FillCheck {
  audit: AuditEntry[]
  /** What the user has to answer before it can go in: each held-back field, as a question with its options. */
  questions: { field: string; why: string; options: string[] }[]
}

/**
 * Check what a fill put in the form against the package and Standard answers. A field the package
 * marks unconfirmed or lists as an open question, a self-identification question Standard answers
 * don't answer outright, or anything the filler made up is unconfirmed and comes back as a
 * question. So does a required question the package marks unconfirmed that the filler left out.
 * Open items the user has settled don't count, and "Not needed" lets a value through only for a
 * hold that came from an open item: never for a marked, self-identification or made-up answer.
 */
export const checkFill = (o: { filled: FilledField[]; needsYou: { field: string }[]; packageMd: string | null; standardAnswers: string; company?: string; settled?: Settled }): FillCheck => {
  const pkg = readPackage(o.packageMd)
  const open = pkg.pending.filter((p) => !o.settled?.item(p))
  const std = standardStatements(o.standardAnswers)
  const drop = keyWords(o.company ?? '')
  const same = (a: string, b: string) => sameQuestion(a, b, drop)
  const audit = o.filled.map((f): AuditEntry => {
    const base = { field: f.field, value: f.value }
    if (pkg.given.some((g) => confirmsField(g.question, f.field, drop))) return { ...base, source: 'user_answer', confirmed: true }
    const kinds = demographicKinds(f.field)
    if (kinds.length)
      return explicitlyStandard(kinds, f.value, std)
        ? { ...base, source: 'standard_answer', confirmed: true }
        : { ...base, source: 'unconfirmed', confirmed: false, why: 'A self-identification question your Standard answers don’t answer in so many words.' }
    const row = pkg.answers.find((r) => r.flag && same(r.question, f.field))
    if (row) return { ...base, source: 'unconfirmed', confirmed: false, why: `The package marks its answer “${row.answer || row.source}” as not confirmed (${row.flag}).` }
    // The resume file itself: open items about its wording aren't about this field.
    const item = f.source === 'resume' || isContact(f.field) ? undefined : open.find((p) => mentions(f.field, p, drop))
    if (item && !o.settled?.passed(f.field, f.value)) return { ...base, source: 'unconfirmed', confirmed: false, why: `Held for this open item in the package: “${truncate(item, 200)}”` }
    const source = f.source ?? 'ai_generated'
    if (source === 'ai_generated') return { ...base, source, confirmed: false, why: 'Not from the package, Standard answers, profile or resume.' }
    return { ...base, source, confirmed: true }
  })
  const questions: FillCheck['questions'] = []
  const asked = (q: string) => [...o.needsYou.map((n) => n.field), ...questions.map((n) => n.field)].some((x) => same(x, q))
  for (const [i, e] of audit.entries()) if (!e.confirmed && !asked(e.field)) questions.push({ field: e.field, why: e.why ?? 'Not confirmed.', options: o.filled[i]!.options ?? [] })
  for (const r of pkg.answers) {
    if (!r.flag || r.required === false || r.source === '' || asked(r.question)) continue
    if (pkg.given.some((g) => confirmsField(g.question, r.question, drop)) || o.filled.some((f) => same(f.field, r.question))) continue
    questions.push({ field: r.question, why: `The package marks its answer “${r.answer}” as not confirmed (${r.flag}).`, options: [] })
  }
  return { audit, questions }
}

/** Why an audited fill can't be submitted, or null when every filled value is confirmed. */
export const submitRefusal = (audit: AuditEntry[] | null | undefined) => {
  if (!audit) return 'There is no audit of what was filled.'
  const bad = audit.filter((e) => !e.confirmed)
  return bad.length ? `Not submitting: ${bad.length} filled answer${bad.length === 1 ? ' isn’t' : 's aren’t'} confirmed (${bad.map((e) => e.field).join(', ')}).` : null
}
