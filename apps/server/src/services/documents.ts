import { eq } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'

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

export const setDoc = (key: DocKey, body: string) => {
  const at = nowIso()
  db.insert(schema.documents).values({ key, body, updatedAt: at }).onConflictDoUpdate({ target: schema.documents.key, set: { body, updatedAt: at } }).run()
  return getDoc(key)
}

export const appendDoc = (key: DocKey, text: string) => {
  const cur = getDoc(key)
  const base = cur.isDefault ? '' : cur.body
  return setDoc(key, `${base.replace(/\s*$/, '')}${base ? '\n\n' : ''}${text.trim()}\n`)
}

/** A document counts as written once it differs from its template. */
export const isWritten = (key: DocKey) => {
  const d = getDoc(key)
  return !d.isDefault && d.body.trim().length > 0 && d.body.trim() !== defaultDoc(key).trim()
}
