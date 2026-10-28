import { and, asc, desc, eq } from 'drizzle-orm'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  diffResume,
  emptyResume,
  insertLineAfter,
  keepChange,
  normalizeContent,
  removeLine,
  type ResumeContent,
  type ResumeNote,
  resumeLines,
  setLine,
  type ThemeOptions,
  undoChange,
} from '@sidedoor/shared/resume'
import { renderResume, sanitizeInline, themeById } from '@sidedoor/shared/resume-themes'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { newId, nowIso, slugify } from '../ids'
import { pdfPageCount, renderPdf } from '../pdf'
import { getSettings } from '../settings'

/**
 * Resumes: structured content rendered by a theme. One "base" resume is the user's main one;
 * tailored copies belong to applications. Agents and the editor both write through these
 * functions; every overwrite snapshots the previous content.
 */

export type Resume = schema.Resume

export const getResume = (id: string): Resume | undefined => db.select().from(schema.resumes).where(eq(schema.resumes.id, id)).get()

export const requireResume = (id: string) => {
  const r = getResume(id)
  if (!r) throw new Error(`No resume ${id}`)
  return r
}

export const listResumes = () =>
  db
    .select({
      id: schema.resumes.id,
      kind: schema.resumes.kind,
      title: schema.resumes.title,
      applicationId: schema.resumes.applicationId,
      theme: schema.resumes.theme,
      pdfFile: schema.resumes.pdfFile,
      pdfPages: schema.resumes.pdfPages,
      updatedAt: schema.resumes.updatedAt,
    })
    .from(schema.resumes)
    .orderBy(asc(schema.resumes.kind), desc(schema.resumes.updatedAt))
    .all()

/** The user's main resume: the oldest base resume. */
export const baseResume = (): Resume | undefined =>
  db.select().from(schema.resumes).where(eq(schema.resumes.kind, 'base')).orderBy(asc(schema.resumes.createdAt)).get()

const sanitize = (c: ResumeContent): ResumeContent => {
  const n = normalizeContent(c)
  const s = (x: string) => sanitizeInline(x)
  if (n.basics.headline) n.basics.headline.text = s(n.basics.headline.text)
  for (const sec of n.sections) {
    if (sec.type === 'summary') sec.text.text = s(sec.text.text)
    if (sec.type === 'experience')
      for (const co of sec.companies) {
        co.name = s(co.name)
        for (const r of co.roles) for (const b of r.bullets) b.text = s(b.text)
      }
    if (sec.type === 'skills') for (const g of sec.groups) g.text = s(g.text)
    if (sec.type === 'list') for (const i of sec.items) i.text = s(i.text)
  }
  return n
}

const snapshot = (r: Resume, reason: string) => {
  db.insert(schema.resumeVersions).values({ id: newId('rv_'), resumeId: r.id, content: r.content, reason, at: nowIso() }).run()
  // Keep the last 50 per resume.
  db.$client
    .prepare('delete from resume_versions where resume_id = ? and id not in (select id from resume_versions where resume_id = ? order by at desc, id desc limit 50)')
    .run(r.id, r.id)
}

export const createResume = atomic(
  (v: { title: string; content?: ResumeContent; theme?: string; themeOptions?: ThemeOptions; kind?: 'base' | 'tailored'; applicationId?: string | null; baseId?: string | null; reviewBase?: ResumeContent | null }) => {
    const you = getSettings().you
    const content = sanitize(v.content ?? emptyResume({ name: you.name, email: you.email, phone: you.phone, location: you.location, links: you.links }))
    const id = newId('res_')
    db.insert(schema.resumes)
      .values({
        id,
        title: v.title,
        kind: v.kind ?? 'base',
        applicationId: v.applicationId ?? null,
        baseId: v.baseId ?? null,
        theme: themeById(v.theme).id,
        themeOptions: v.themeOptions ?? {},
        content,
        reviewBase: v.reviewBase ? sanitize(v.reviewBase) : content,
      })
      .run()
    return requireResume(id)
  },
)

/**
 * Replace a resume's content. `by` decides what the review shows: the user's own edits move the
 * review base along with them (they don't need reviewing); an agent's edits stay pending until the
 * user keeps or undoes each line. `baseVersion` guards against overwriting a concurrent edit.
 */
export const saveContent = atomic((id: string, content: ResumeContent, opts: { by: 'user' | 'agent'; baseVersion?: number; reason?: string }) => {
  const r = requireResume(id)
  if (opts.baseVersion !== undefined && opts.baseVersion !== r.version) return { ok: false as const, conflict: true as const, resume: r }
  const next = sanitize(content)
  snapshot(r, opts.reason ?? (opts.by === 'agent' ? 'agent edit' : 'edit'))
  let reviewBase = r.reviewBase ?? r.content
  if (opts.by === 'user') {
    // Lines the user edited count as reviewed, except lines with a pending agent change.
    const pending = new Set(diffResume(reviewBase, r.content).map((c) => c.id))
    for (const ch of diffResume(r.content, next)) if (!pending.has(ch.id)) reviewBase = keepChange(reviewBase, next, ch.id)
  }
  db.update(schema.resumes)
    .set({ content: next, reviewBase, version: r.version + 1, updatedAt: nowIso() })
    .where(eq(schema.resumes.id, id))
    .run()
  return { ok: true as const, resume: requireResume(id) }
})

/** Set several lines at once (the in-place editor saves this way). */
export const setLines = (id: string, lines: Record<string, string>, opts: { by: 'user' | 'agent'; baseVersion?: number }) => {
  const r = requireResume(id)
  let c = r.content
  for (const [lineId, html] of Object.entries(lines)) c = setLine(c, lineId, html)
  return saveContent(id, c, opts)
}

export const addLine = (id: string, after: string, html: string, by: 'user' | 'agent') => {
  const r = requireResume(id)
  const res = insertLineAfter(r.content, after, html)
  saveContent(id, res.content, { by })
  return res.id
}

export const deleteLine = (id: string, lineId: string, by: 'user' | 'agent') => saveContent(id, removeLine(requireResume(id).content, lineId), { by })

export const reviewAction = atomic((id: string, action: 'keep' | 'undo' | 'keep-all' | 'undo-all', lineId?: string) => {
  const r = requireResume(id)
  const base = r.reviewBase ?? r.content
  let content = r.content
  let reviewBase = base
  const ids = lineId ? [lineId] : diffResume(base, r.content).map((c) => c.id)
  for (const l of ids) {
    if (action === 'keep' || action === 'keep-all') reviewBase = keepChange(reviewBase, content, l)
    else content = undoChange(reviewBase, content, l)
  }
  if (content !== r.content) snapshot(r, 'undo')
  db.update(schema.resumes)
    .set({ content, reviewBase, version: content !== r.content ? r.version + 1 : r.version, updatedAt: nowIso() })
    .where(eq(schema.resumes.id, id))
    .run()
  return requireResume(id)
})

export const setTheme = (id: string, theme: string, themeOptions?: ThemeOptions) => {
  requireResume(id)
  db.update(schema.resumes)
    .set({ theme: themeById(theme).id, ...(themeOptions ? { themeOptions } : {}), updatedAt: nowIso() })
    .where(eq(schema.resumes.id, id))
    .run()
  return requireResume(id)
}

export const renameResume = (id: string, title: string) => {
  db.update(schema.resumes).set({ title, updatedAt: nowIso() }).where(eq(schema.resumes.id, id)).run()
  return requireResume(id)
}

export const deleteResume = atomic((id: string) => {
  const r = requireResume(id)
  db.delete(schema.resumes).where(eq(schema.resumes.id, id)).run()
  db.delete(schema.resumeVersions).where(eq(schema.resumeVersions.resumeId, id)).run()
  if (r.applicationId) db.update(schema.applications).set({ resumeId: null }).where(eq(schema.applications.resumeId, id)).run()
})

/** The tailored resume for an application, created from the base resume if it doesn't exist yet. */
export const tailoredFor = atomic((applicationId: string) => {
  const a = db.select().from(schema.applications).where(eq(schema.applications.id, applicationId)).get()
  if (!a) throw new Error('application missing')
  const existing = a.resumeId ? getResume(a.resumeId) : db.select().from(schema.resumes).where(and(eq(schema.resumes.applicationId, applicationId), eq(schema.resumes.kind, 'tailored'))).get()
  if (existing) {
    if (a.resumeId !== existing.id) db.update(schema.applications).set({ resumeId: existing.id }).where(eq(schema.applications.id, a.id)).run()
    return existing
  }
  const base = baseResume()
  if (!base) throw new Error('There is no main resume yet. Create one on the Resume page first.')
  // Review base = the main resume, so the tailoring itself shows up as changes to review.
  const r = createResume({
    title: `${a.companyName} – ${a.role}`,
    kind: 'tailored',
    applicationId,
    baseId: base.id,
    theme: base.theme,
    themeOptions: base.themeOptions,
    content: base.content,
    reviewBase: base.content,
  })
  db.update(schema.applications).set({ resumeId: r.id }).where(eq(schema.applications.id, a.id)).run()
  return r
})

/** The resume an application's match check reads: its tailored copy, else the main resume. */
export const resumeForApplication = (a: { resumeId: string | null }) => (a.resumeId ? getResume(a.resumeId) : undefined) ?? baseResume()

export const renderHtml = (r: Pick<Resume, 'content' | 'theme' | 'themeOptions'>) => renderResume(r.content, r.theme, r.themeOptions)

/** Render the PDF into the files dir and record its page count. */
export const buildResumePdf = async (id: string) => {
  const r = requireResume(id)
  const pdf = await renderPdf(renderHtml(r))
  const pages = pdfPageCount(pdf)
  const you = getSettings().you.name || 'resume'
  const dir = resolve(paths.files, 'resumes', id)
  mkdirSync(dir, { recursive: true })
  const name = `${slugify(you)}-resume${r.kind === 'tailored' ? `-${slugify(r.title).slice(0, 60)}` : ''}.pdf`
  writeFileSync(resolve(dir, name), pdf)
  const file = `resumes/${id}/${name}`
  db.update(schema.resumes).set({ pdfFile: file, pdfPages: pages, pdfAt: nowIso() }).where(eq(schema.resumes.id, id)).run()
  return { file, pages, path: resolve(paths.files, file) }
}

export const resumeChanges = (r: Resume) => diffResume(r.reviewBase, r.content)
export const linesOf = (r: Pick<Resume, 'content'>) => resumeLines(r.content)

export const versionsOf = (id: string) =>
  db.select({ id: schema.resumeVersions.id, reason: schema.resumeVersions.reason, at: schema.resumeVersions.at }).from(schema.resumeVersions).where(eq(schema.resumeVersions.resumeId, id)).orderBy(desc(schema.resumeVersions.at)).limit(50).all()

export const restoreVersion = (id: string, versionId: string) => {
  const v = db.select().from(schema.resumeVersions).where(eq(schema.resumeVersions.id, versionId)).get()
  if (!v || v.resumeId !== id) throw new Error('version not found')
  return saveContent(id, v.content, { by: 'user', reason: 'restore' })
}

// ------------------------------------------------------------------------------------- notes

const localNow = () => new Date().toISOString().slice(0, 19)

export const noteAction = atomic(
  (id: string, v: { action: 'add' | 'reply' | 'status' | 'answer'; noteId?: string; target?: string | null; quote?: string; text?: string; status?: ResumeNote['status']; who?: 'user' | 'agent'; suggestions?: string[] }) => {
    const r = requireResume(id)
    const notes = [...r.notes]
    let note: ResumeNote | undefined
    if (v.action === 'add') {
      if (!v.text) throw new Error('text required')
      note = { id: newId('').slice(0, 8), target: v.target ?? null, quote: v.quote ?? '', status: 'open', thread: [{ who: v.who ?? 'user', text: v.text, at: localNow() }] }
      notes.push(note)
    } else {
      note = notes.find((n) => n.id === v.noteId)
      if (!note) throw new Error('note not found')
      if ((v.action === 'reply' || v.action === 'answer') && v.text) {
        note.thread.push({ who: v.action === 'answer' ? 'agent' : (v.who ?? 'user'), text: v.text, at: localNow() })
        note.status = v.action === 'answer' ? (v.status ?? 'answered') : 'open'
        if (v.suggestions) note.suggestions = v.suggestions
      } else if (v.action === 'status' && v.status) note.status = v.status
    }
    db.update(schema.resumes).set({ notes, updatedAt: nowIso() }).where(eq(schema.resumes.id, id)).run()
    return note
  },
)
