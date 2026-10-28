import { resumeAsText } from '@sidedoor/shared/resume'
import { z } from 'zod'
import { logActivity } from '../activity'
import { DOCS, type DocKey, appendDoc, getDoc, setDoc } from '../services/documents'
import { tool } from './define'

const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true })
const safe =
  <A,>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
const ro = { annotations: { readOnlyHint: true } }

const docKey = z.enum(Object.keys(DOCS) as [DocKey, ...DocKey[]])
const resumes = () => import('../services/resumes')

const lineHtml = z.string().describe('the line as inline HTML: plain text, optionally <strong>, <em>, <a href>. Compound lines: skills "<strong>Label:</strong> items", roles "Title · Dates"')

/** The user's profile documents and resumes. All writes go through the same service commands as the UI. */
export const profileTools = [
  tool(
    'get_profile_doc',
    `Read one of the user's profile documents: ${Object.entries(DOCS)
      .map(([k, d]) => `'${k}' (${d.hint})`)
      .join('; ')}.`,
    { key: docKey },
    safe(({ key }) => {
      const d = getDoc(key)
      return { key, title: DOCS[key].title, body: d.body, updatedAt: d.updatedAt, isTemplate: d.isDefault }
    }),
    ro,
  ),

  tool(
    'update_profile_doc',
    "Change a profile document. mode 'append' adds a section at the end (use it to record a fact the user just confirmed in Experience); mode 'replace' rewrites the whole document (only when the user asked you to rewrite or reorganize it, and keep everything they wrote). Never add a fact the user hasn't told you.",
    { key: docKey, mode: z.enum(['append', 'replace']), text: z.string() },
    safe(({ key, mode, text }) => {
      const d = mode === 'append' ? appendDoc(key, text) : setDoc(key, text)
      logActivity('system', `An agent ${mode === 'append' ? 'added to' : 'rewrote'} ${DOCS[key].title}`, { link: `/profile/${key}` })
      return { saved: true, chars: d.body.length }
    }),
  ),

  tool(
    'list_resumes',
    "The user's resumes: the main (base) resume and tailored copies per application.",
    {},
    safe(async () => (await resumes()).listResumes()),
    ro,
  ),

  tool(
    'get_resume',
    'One resume: every line with its id (edit lines by id), the theme, the last PDF page count, and the lines changed since the user last reviewed it. Pass format "json" for the full structured content (for big rewrites with replace_resume_content).',
    { resumeId: z.string().optional().describe('omit for the main resume'), format: z.enum(['lines', 'json']).optional() },
    safe(async ({ resumeId, format }) => {
      const m = await resumes()
      const r = resumeId ? m.requireResume(resumeId) : m.baseResume()
      if (!r) throw new Error('There is no resume yet. Ask the user to create one on the Resume page or import one.')
      const base = { id: r.id, kind: r.kind, title: r.title, applicationId: r.applicationId, theme: r.theme, pdfPages: r.pdfPages, version: r.version, pendingChanges: m.resumeChanges(r).length }
      if (format === 'json') return { ...base, content: r.content }
      return { ...base, lines: m.linesOf(r).map((l) => ({ id: l.id, kind: l.kind, where: l.path, text: l.html })), asText: resumeAsText(r.content) }
    }),
    ro,
  ),

  tool(
    'update_resume_lines',
    "Edit resume lines in place by id. The user reviews every line you change in the resume editor (keep or undo), so edit directly instead of listing suggestions. Facts come only from the Experience document. Run build_resume_pdf afterwards to check the page count.",
    { resumeId: z.string(), lines: z.record(z.string(), lineHtml).describe('{ lineId: newHtml }') },
    safe(async ({ resumeId, lines }) => {
      const r = (await resumes()).setLines(resumeId, lines, { by: 'agent' })
      return { saved: Object.keys(lines).length, version: r.resume.version }
    }),
  ),

  tool(
    'add_resume_line',
    'Add a bullet after an existing bullet (or as the first bullet of a role when `after` is the role id), or a skill group after a skill group. Returns the new line id.',
    { resumeId: z.string(), after: z.string(), text: lineHtml },
    safe(async ({ resumeId, after, text }) => ({ id: (await resumes()).addLine(resumeId, after, text, 'agent') })),
  ),

  tool(
    'remove_resume_line',
    'Remove a bullet, skill group, highlight, list item or whole section by id.',
    { resumeId: z.string(), lineId: z.string() },
    safe(async ({ resumeId, lineId }) => {
      ;(await resumes()).deleteLine(resumeId, lineId, 'agent')
      return { removed: lineId }
    }),
  ),

  tool(
    'replace_resume_content',
    'Replace a resume\'s whole structured content (get it first with get_resume format "json"). Keep the ids of lines you keep, so the review shows real changes; give new lines no id. Use for reordering sections, moving bullets between roles, or building a resume from scratch.',
    { resumeId: z.string(), content: z.record(z.string(), z.unknown()).describe('ResumeContent JSON: { version: 1, basics, highlights, sections }') },
    safe(async ({ resumeId, content }) => {
      const r = (await resumes()).saveContent(resumeId, content as never, { by: 'agent', reason: 'agent rewrite' })
      return { saved: true, version: r.resume.version }
    }),
  ),

  tool(
    'create_tailored_resume',
    "Get the tailored resume for an application, creating it from the main resume if it doesn't exist. Edit the returned resume, never the main one, when tailoring for a job.",
    { applicationId: z.string() },
    safe(async ({ applicationId }) => {
      const r = (await resumes()).tailoredFor(applicationId)
      return { resumeId: r.id, title: r.title }
    }),
  ),
]
