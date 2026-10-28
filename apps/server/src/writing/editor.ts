import { eq, inArray } from 'drizzle-orm'
import { z } from 'zod'
import { describeReport } from '@sidedoor/shared/tells'
import { extractProseSections, replaceSections } from '@sidedoor/shared/package-sections'
import { resolveJobAi, runJob } from '../ai'
import { render, userName } from '../prompts'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { getApplication, updateApplication } from '../services/applications'
import { updateDraft } from '../services/people'
import { checkTells, writingRules } from './tells'

// The editor pass: a second, separate AI call that applies the user's writing style to a draft
// with the "only very slightly edit" instruction. Pure text model (no tools), so it can only work
// from the draft itself, plus code guards that reject edits introducing new numbers or bloat.

export interface EditInput {
  key: string
  title: string
  text: string
}
export interface EditResult {
  key: string
  title: string
  original: string
  edited: string
  changes: schema.EditorChange[]
  /** Why the editor's version was thrown away (original kept), if it was. */
  rejected?: string
}

const EditorOut = z.object({
  items: z.array(
    z.object({
      key: z.string(),
      edited: z.string(),
      changes: z.array(z.object({ what: z.string(), why: z.string() })).default([]),
    }),
  ),
})

const numbers = (s: string) => new Set(s.match(/\d+(?:[.,]\d+)*/g) ?? [])

/** Code-level guard for "must not add facts": no new numbers, no big growth, nothing empty. */
const rejectReason = (original: string, edited: string) => {
  if (!edited.trim()) return 'editor returned empty text'
  const before = numbers(original)
  const added = [...numbers(edited)].filter((n) => !before.has(n))
  if (added.length) return `editor introduced numbers not in the draft (${added.join(', ')})`
  if (edited.length > original.length * 1.2 + 40) return 'editor made it more than 20% longer'
  return undefined
}

export const editorModel = () => {
  const r = resolveJobAi('editor')
  return `${r.provider}${r.model ? `/${r.model}` : ''}`
}

export async function editorPass(items: EditInput[], purpose: string): Promise<EditResult[]> {
  if (!items.length) return []
  const blocks = items.map((it) => {
    const tells = checkTells(it.text)
    return `### Piece key="${it.key}" (${it.title})\nTells: ${describeReport(tells)}\n\n<<<TEXT\n${it.text}\nTEXT>>>`
  })
  const prompt = render('editor', { PURPOSE: purpose, ITEMS: blocks.join('\n\n'), WRITING_RULES: writingRules() || '(no writing style set; apply the rules summarized above)' })
  const r = await runJob({ job: 'editor', prompt, schema: EditorOut, maxTurns: 3, timeoutMs: 10 * 60_000 })
  const byKey = new Map(r.data.items.map((x) => [x.key, x]))
  return items.map((it) => {
    const got = byKey.get(it.key)
    if (!got) return { key: it.key, title: it.title, original: it.text, edited: it.text, changes: [], rejected: 'editor skipped this piece' }
    const edited = got.edited.replace(/^<<<TEXT\n?|\n?TEXT>>>$/g, '').trim()
    const why = rejectReason(it.text, edited)
    if (why) return { key: it.key, title: it.title, original: it.text, edited: it.text, changes: [], rejected: why }
    return { key: it.key, title: it.title, original: it.text, edited, changes: got.changes.slice(0, 12) }
  })
}

const draftPurpose = () =>
  `Outreach drafts ${userName()} will send themselves from email, LinkedIn or X: short emails to hiring managers, founders and recruiters, LinkedIn connection notes, X DMs, and follow-ups. Warm, plain, short, specific.`

/** Run the editor over outreach drafts. The edited text becomes `body`; the agent's draft is kept in `originalBody`. */
export async function editDrafts(ids: string[]) {
  if (!ids.length) return { edited: 0 }
  const rows = db.select().from(schema.drafts).where(inArray(schema.drafts.id, ids)).all()
  const people = new Map(
    db.select().from(schema.people).where(inArray(schema.people.id, rows.map((d) => d.personId).filter((x): x is string => !!x))).all().map((p) => [p.id, p]),
  )
  const items = rows.map((d) => ({ key: d.id, title: `${d.channel} to ${d.personId ? (people.get(d.personId)?.name ?? 'contact') : 'contact'}${d.subject ? `, subject "${d.subject}"` : ''}`, text: d.body }))
  try {
    const results = await editorPass(items, draftPurpose())
    let edited = 0
    for (const res of results) {
      const changes = res.rejected ? [{ what: 'Kept the original draft', why: res.rejected }] : res.changes
      updateDraft(res.key, { originalBody: res.original, body: res.edited, editorChanges: changes, editedAt: nowIso(), editorError: null })
      if (!res.rejected && res.edited !== res.original) edited++
    }
    return { edited }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    for (const id of ids) updateDraft(id, { editorError: msg.slice(0, 500) })
    console.error('[editor] drafts failed', msg)
    return { edited: 0, error: msg }
  }
}

const packagePurpose = () =>
  `Parts of a job application ${userName()} will paste into the form themselves: a cover letter (about 200-280 words, for a named role, so no hook) and free-text answers to the form questions. Their voice is warm, plain and specific.`

/**
 * Run the editor over a prep package's cover letter and free-text answers. The edited sections are
 * written into packageMd; the pre-edit package is kept in packageOriginalMd.
 */
export async function editPackage(applicationId: string) {
  const a = getApplication(applicationId)
  if (!a?.packageMd) throw new Error('No package to edit')
  const md = a.packageMd
  const sections = extractProseSections(md)
  const model = editorModel()
  if (!sections.length) {
    updateApplication(a.id, { editorJson: { at: nowIso(), model, items: [] } })
    return { edited: 0 }
  }
  let results: EditResult[]
  try {
    results = await editorPass(sections.map((s) => ({ key: s.key, title: s.title, text: s.text })), packagePurpose())
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    updateApplication(a.id, { editorJson: { at: nowIso(), model, error: msg.slice(0, 500), items: [] } })
    console.error('[editor] package failed', msg)
    return { edited: 0, error: msg }
  }
  const next = replaceSections(md, Object.fromEntries(results.map((r) => [r.key, r.edited])))
  updateApplication(a.id, {
    packageMd: next,
    packageOriginalMd: md,
    editorJson: { at: nowIso(), model, items: results },
  })
  return { edited: results.filter((r) => !r.rejected && r.edited !== r.original).length }
}
