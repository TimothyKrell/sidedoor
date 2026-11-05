import { and, eq, getTableColumns, sql } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { newId, nowIso } from '../ids'
import { docChanged } from './stale-flags'

/**
 * The user's profile documents (markdown, owned by the app). Each starts from a template in
 * defaults/ until the user (or onboarding, or an agent) writes it.
 */
export const DOCS = {
  experience: { title: 'Experience', hint: 'Everything you have done. The only source of facts agents may use.' },
  search: { title: 'What I want', hint: 'The roles, places and companies you want. Triage scores against this.' },
  answers: { title: 'Standard answers', hint: 'Work authorization, start date, salary and other form answers.' },
  writing: { title: 'Writing style', hint: 'How you sound. Agents follow it for anything you will send.' },
  stories: { title: 'Story bank', hint: 'Career stories captured in interviews, ready to use in letters and answers.' },
  tells: { title: 'Writing check rules', hint: 'Patterns the writing check flags (JSON).' },
} as const
export type DocKey = keyof typeof DOCS

const DEFAULT_FILES: Partial<Record<DocKey, string>> = { experience: 'experience.md', search: 'search.md', answers: 'answers.md', writing: 'writing.md', tells: 'tells.json' }

export const defaultDoc = (key: DocKey) => {
  const f = DEFAULT_FILES[key]
  const p = f ? resolve(paths.defaults, f) : null
  return p && existsSync(p) ? readFileSync(p, 'utf8') : ''
}

export const getDoc = (key: DocKey): { key: DocKey; body: string; updatedAt: string | null; isDefault: boolean } => {
  const row = db.select().from(schema.documents).where(eq(schema.documents.key, key)).get()
  if (row) return { key, body: row.body, updatedAt: row.updatedAt, isDefault: false }
  return { key, body: defaultDoc(key), updatedAt: null, isDefault: true }
}

export const docBody = (key: DocKey) => getDoc(key).body

export type DocAuthor = 'user' | 'agent' | 'app'
export interface DocWrite {
  by?: DocAuthor
  reason?: string
  /** Allow a change that removes more than MAX_UNCONFIRMED_REMOVAL of the document. */
  confirmLargeDeletion?: boolean
}

/**
 * An edit may remove at most this fraction of a document (and more than SMALL_REMOVAL characters)
 * unless the caller confirms it, so a bad find/replace or a truncated rewrite can't wipe it.
 */
export const MAX_UNCONFIRMED_REMOVAL = 0.25
const SMALL_REMOVAL = 200

const storedBody = (key: DocKey) => db.select({ body: schema.documents.body }).from(schema.documents).where(eq(schema.documents.key, key)).get()?.body ?? null

/** null puts the document back to its template. Every change keeps a revision (before and after). */
const writeDoc = (key: DocKey, body: string | null, w: DocWrite = {}) => {
  const before = storedBody(key)
  if (before === body) return getDoc(key)
  const was = getDoc(key).body
  // Only the user's own text counts: replacing the template removes nothing of theirs.
  const removed = (before ?? '').length - (body ?? '').length
  if (before && !w.confirmLargeDeletion && removed > SMALL_REMOVAL && removed > before.length * MAX_UNCONFIRMED_REMOVAL)
    throw new Error(
      `This would remove ${removed} of ${DOCS[key].title}'s ${before.length} characters (${Math.round((removed / before.length) * 100)}%). If that's intended, pass confirmLargeDeletion: true.`,
    )
  if (key === 'tells' && body != null) JSON.parse(body)
  const at = nowIso()
  db.insert(schema.documentRevisions).values({ id: newId('drev_'), docKey: key, before, after: body, by: w.by ?? 'app', reason: w.reason ?? null, at }).run()
  if (body == null) db.delete(schema.documents).where(eq(schema.documents.key, key)).run()
  else db.insert(schema.documents).values({ key, body, updatedAt: at }).onConflictDoUpdate({ target: schema.documents.key, set: { body, updatedAt: at } }).run()
  // Unsent drafts may now say something this contradicts; check them in the background.
  docChanged(key, was, body ?? getDoc(key).body)
  return getDoc(key)
}

export const setDoc = atomic((key: DocKey, body: string, w: DocWrite = {}) => writeDoc(key, body, { confirmLargeDeletion: true, ...w }))

export const appendDoc = (key: DocKey, text: string, w: DocWrite = {}) => editDoc(key, { op: 'append', text }, w)

// ------------------------------------------------------------------ targeted edits

/** A change to part of a document, so a stale line can be corrected instead of contradicted. */
export type DocEdit =
  | { op: 'append'; text: string }
  | { op: 'replace_all'; text: string }
  /** Exact text, which must appear exactly once. An empty replace deletes it (whole lines go with their line break). */
  | { op: 'replace_text'; find: string; replace: string }
  /** The section under a heading, up to the next heading of the same or a higher level (subsections included). */
  | { op: 'replace_section'; heading: string; text: string }
  | { op: 'delete_section'; heading: string }
  | { op: 'insert_under_heading'; heading: string; text: string; position?: 'start' | 'end' }

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
/** Blank lines off both ends; indentation of the first line stays. */
const tidy = (s: string) => s.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd()

const countOf = (s: string, find: string) => {
  let n = 0
  for (let i = s.indexOf(find); i !== -1; i = s.indexOf(find, i + find.length)) n++
  return n
}

interface Section {
  start: number
  /** Where the heading line ends (after its line break). */
  bodyStart: number
  end: number
  heading: string
  hasNext: boolean
}

/** The one section whose heading matches ("## Skills" or just "Skills"). */
export const findSection = (body: string, heading: string): Section => {
  const want = heading.trim()
  const wantText = HEADING.exec(want)?.[2] ?? want
  const lines: { at: number; line: string; level: number; text: string }[] = []
  let at = 0
  for (const line of body.split('\n')) {
    const m = HEADING.exec(line)
    if (m) lines.push({ at, line, level: m[1]!.length, text: m[2]! })
    at += line.length + 1
  }
  const hits = lines.filter((h) => h.line.trim() === want || h.text === wantText)
  if (hits.length === 0)
    throw new Error(`No heading "${want}". Headings: ${lines.map((h) => h.line.trim()).join(' | ') || '(none)'}`)
  if (hits.length > 1) throw new Error(`"${want}" matches ${hits.length} headings; use the full heading line, or edit with replace_text.`)
  const h = hits[0]!
  const next = lines.find((x) => x.at > h.at && x.level <= h.level)
  const bodyStart = Math.min(body.length, h.at + h.line.length + 1)
  return { start: h.at, bodyStart, end: next?.at ?? body.length, heading: h.line.trimEnd(), hasNext: !!next }
}

const rebuild = (body: string, s: Section, heading: string, text: string) => {
  const inner = tidy(text)
  const section = `${heading}\n${inner ? `\n${inner}\n` : ''}${s.hasNext ? '\n' : ''}`
  return body.slice(0, s.start) + section + body.slice(s.end)
}

/** Apply an edit to a document's text. Pure; throws a message an agent can act on. */
export const applyDocEdit = (body: string, e: DocEdit): string => {
  switch (e.op) {
    case 'append':
      return `${body.replace(/\s*$/, '')}${body.trim() ? '\n\n' : ''}${e.text.trim()}\n`
    case 'replace_all':
      return e.text
    case 'replace_text': {
      if (!e.find) throw new Error('find is empty.')
      const n = countOf(body, e.find)
      if (n === 0) throw new Error('That text is not in the document. Copy it exactly from get_profile_doc (spacing and punctuation included).')
      if (n > 1) throw new Error(`That text appears ${n} times. Include more of the surrounding text so it matches once.`)
      let start = body.indexOf(e.find)
      let end = start + e.find.length
      if (e.replace === '' && (start === 0 || body[start - 1] === '\n') && (end === body.length || body[end] === '\n' || e.find.endsWith('\n'))) {
        // Deleting whole lines: take a line break with them.
        if (body[end] === '\n') end++
        else if (!e.find.endsWith('\n') && start > 0) start--
      }
      return body.slice(0, start) + e.replace + body.slice(end)
    }
    case 'replace_section': {
      const s = findSection(body, e.heading)
      const [first = '', ...rest] = tidy(e.text).split('\n')
      return HEADING.test(first) ? rebuild(body, s, first.trimEnd(), rest.join('\n')) : rebuild(body, s, s.heading, e.text)
    }
    case 'delete_section': {
      const s = findSection(body, e.heading)
      const out = body.slice(0, s.start) + body.slice(s.end)
      return s.hasNext ? out : `${out.trimEnd()}\n`
    }
    case 'insert_under_heading': {
      const s = findSection(body, e.heading)
      const cur = tidy(body.slice(s.bodyStart, s.end))
      const parts = e.position === 'start' ? [e.text, cur] : [cur, e.text]
      return rebuild(body, s, s.heading, parts.map(tidy).filter(Boolean).join('\n\n'))
    }
  }
}

const EDIT_REASONS: Record<DocEdit['op'], string> = {
  append: 'added a section',
  replace_all: 'rewrote it',
  replace_text: 'corrected text',
  replace_section: 'replaced a section',
  delete_section: 'deleted a section',
  insert_under_heading: 'added under a heading',
}

/** Change part of a document. Refuses a change that removes most of it unless confirmed. */
export const editDoc = atomic((key: DocKey, e: DocEdit, w: DocWrite = {}) => {
  const cur = getDoc(key)
  // Appending to a template starts the document fresh, as before.
  const base = cur.isDefault && e.op === 'append' ? '' : cur.body
  const next = applyDocEdit(base, e)
  if (next === cur.body && !cur.isDefault) return cur
  return writeDoc(key, next, { reason: EDIT_REASONS[e.op], ...w })
})

// ------------------------------------------------------------------ revisions

/** Where two texts differ: the changed part of each, with the shared text around it left out. */
export const changedSpan = (a: string, b: string) => {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let q = 0
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++
  return { at: p, removed: a.slice(p, a.length - q), added: b.slice(p, b.length - q) }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s)

/** A document's revisions, newest first, each with what it removed and added. */
export const listRevisions = (key: DocKey, limit = 30, clipAt = 600) =>
  db
    .select()
    .from(schema.documentRevisions)
    .where(eq(schema.documentRevisions.docKey, key))
    // rowid: insertion order, exact even within one millisecond.
    .orderBy(sql`rowid desc`)
    .limit(limit)
    .all()
    .map((r) => {
      const d = changedSpan(r.before ?? defaultDoc(key), r.after ?? defaultDoc(key))
      return {
        id: r.id,
        by: r.by,
        reason: r.reason,
        at: r.at,
        chars: { before: (r.before ?? '').length, after: (r.after ?? '').length },
        fromTemplate: r.before == null,
        toTemplate: r.after == null,
        change: { at: d.at, removed: clip(d.removed, clipAt), added: clip(d.added, clipAt) },
      }
    })

export const getRevision = (id: string) => {
  const r = db.select({ ...getTableColumns(schema.documentRevisions), seq: sql<number>`rowid` }).from(schema.documentRevisions).where(eq(schema.documentRevisions.id, id)).get()
  if (!r) throw new Error(`No revision ${id}`)
  return { ...r, docKey: r.docKey as DocKey }
}

/**
 * Put a document back to how it was before a revision. When later revisions changed it again,
 * reverting would undo those too, so that needs overwriteLaterEdits. The revert is a revision itself.
 */
export const revertRevision = atomic((id: string, w: DocWrite & { overwriteLaterEdits?: boolean } = {}) => {
  const r = getRevision(id)
  const key = r.docKey
  if (!(key in DOCS)) throw new Error(`Unknown document ${key}`)
  if (storedBody(key) !== r.after && !w.overwriteLaterEdits) {
    const later = db
      .select({ id: schema.documentRevisions.id })
      .from(schema.documentRevisions)
      .where(and(eq(schema.documentRevisions.docKey, key), sql`rowid > ${r.seq}`))
      .all().length
    throw new Error(
      `${DOCS[key].title} changed after this revision (${later} later revision${later === 1 ? '' : 's'}). Reverting would undo those too: revert the later ones first, or pass overwriteLaterEdits: true.`,
    )
  }
  return writeDoc(key, r.before, { by: w.by ?? 'app', reason: w.reason ?? `reverted ${r.id}${r.reason ? ` (${r.reason})` : ''}`, confirmLargeDeletion: w.confirmLargeDeletion })
})

/** A document counts as written once it differs from its template. */
export const isWritten = (key: DocKey) => {
  const d = getDoc(key)
  return !d.isDefault && d.body.trim().length > 0 && d.body.trim() !== defaultDoc(key).trim()
}
