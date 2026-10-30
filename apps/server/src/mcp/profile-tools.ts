import { resumeAsText } from '@sidedoor/shared/resume'
import { z } from 'zod'
import { logActivity } from '../activity'
import { DOCS, type DocEdit, type DocKey, MAX_UNCONFIRMED_REMOVAL, editDoc, getDoc, listRevisions, revertRevision } from '../services/documents'
import { outlineOf, pageOf } from '../text'
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

const reason = z.string().min(1).describe("why, in a few words (e.g. 'user: familiar with OpenTelemetry, has not used it'); kept with the revision")
const confirmLargeDeletion = z.boolean().optional().describe('allow removing a large part of the document; only when the user asked for it')

const lineHtml = z.string().describe('the line as inline HTML: plain text, optionally <strong>, <em>, <a href>. Compound lines: skills "<strong>Label:</strong> items", roles "Title · Dates"')

/** The user's profile documents and resumes. All writes go through the same service commands as the UI. */
export const profileTools = [
  tool(
    'get_profile_doc',
    `Read one of the user's profile documents: ${Object.entries(DOCS)
      .map(([k, d]) => `'${k}' (${d.hint})`)
      .join('; ')}. Long documents come in pages of up to 20,000 characters: when nextOffset isn't null, call again with offset = nextOffset until it is, before relying on the document (the newest sections are at the end). sections lists every heading and its offset, to jump straight to one.`,
    {
      key: docKey,
      offset: z.number().int().min(0).optional().describe('where to start reading, from nextOffset or a section offset (default 0)'),
      limit: z.number().int().min(1000).max(40_000).optional().describe('characters per page (default 20000)'),
    },
    safe(({ key, offset, limit }) => {
      const d = getDoc(key)
      const page = pageOf(d.body, offset ?? 0, limit ?? 20_000)
      const paged = page.offset > 0 || page.nextOffset != null
      return {
        key,
        title: DOCS[key].title,
        updatedAt: d.updatedAt,
        isTemplate: d.isDefault,
        offset: page.offset,
        totalChars: page.totalChars,
        nextOffset: page.nextOffset,
        ...(paged ? { sections: outlineOf(d.body) } : {}),
        body: page.text,
      }
    }),
    ro,
  ),

  tool(
    'update_profile_doc',
    "Add to or rewrite a profile document. mode 'append' adds a new section at the end (for a fact the user just confirmed that Experience doesn't cover yet); mode 'replace' rewrites the whole document (only when the user asked you to rewrite or reorganize it, and keep everything they wrote). To correct or remove something already in the document, use edit_profile_doc instead of appending a contradiction. Never add a fact the user hasn't told you.",
    {
      key: docKey,
      mode: z.enum(['append', 'replace']),
      text: z.string(),
      reason: reason.optional(),
      confirmLargeDeletion,
    },
    safe(({ key, mode, text, reason, confirmLargeDeletion }) => {
      const d = editDoc(key, mode === 'append' ? { op: 'append', text } : { op: 'replace_all', text }, { by: 'agent', ...(reason ? { reason } : {}), confirmLargeDeletion })
      logActivity('system', `An agent ${mode === 'append' ? 'added to' : 'rewrote'} ${DOCS[key].title}`, { link: `/profile/${key}`, ...(reason ? { detail: reason } : {}) })
      return { saved: true, chars: d.body.length }
    }),
  ),

  tool(
    'edit_profile_doc',
    `Correct part of a profile document in place, so it never says two different things. Use it when a line is stale or wrong (the user corrected it, or it contradicts what they just told you): fix that line instead of appending a newer section. Operations:
- 'replace_text': find must be exact text from the document (copy it from get_profile_doc, spacing and punctuation included) and appear exactly once, otherwise nothing changes and the error says why; include more surrounding text to make it unique. replace is the new text; an empty replace deletes it (a whole line goes with its line break).
- 'replace_section': replaces everything under heading (e.g. "## Skills" or "Skills") up to the next heading of the same or higher level, subsections included, with text. If text starts with a heading line, that becomes the new heading; otherwise the heading stays.
- 'delete_section': removes the heading and its section.
- 'insert_under_heading': adds text at the end of that heading's section (position 'start' for right under the heading).
Every edit keeps a revision (list_profile_doc_revisions, revert_profile_doc). An edit that would remove more than ${MAX_UNCONFIRMED_REMOVAL * 100}% of the document is refused unless confirmLargeDeletion is true: only set it when the user asked for that removal. Never add a fact the user hasn't told you.`,
    {
      key: docKey,
      op: z.enum(['replace_text', 'replace_section', 'delete_section', 'insert_under_heading']),
      find: z.string().optional().describe("replace_text: the exact text to change, matching once"),
      replace: z.string().optional().describe("replace_text: what it becomes ('' deletes it)"),
      heading: z.string().optional().describe('replace_section / delete_section / insert_under_heading: the heading line, e.g. "## Skills"'),
      text: z.string().optional().describe('replace_section / insert_under_heading: the new markdown'),
      position: z.enum(['start', 'end']).optional().describe("insert_under_heading: 'end' of the section (default) or 'start'"),
      reason,
      confirmLargeDeletion,
    },
    safe(({ key, op, find, replace, heading, text, position, reason, confirmLargeDeletion }) => {
      const need = <T,>(v: T | undefined, name: string): T => {
        if (v === undefined) throw new Error(`${op} needs ${name}.`)
        return v
      }
      const e: DocEdit =
        op === 'replace_text'
          ? { op, find: need(find, 'find'), replace: need(replace, 'replace') }
          : op === 'delete_section'
            ? { op, heading: need(heading, 'heading') }
            : op === 'replace_section'
              ? { op, heading: need(heading, 'heading'), text: need(text, 'text') }
              : { op, heading: need(heading, 'heading'), text: need(text, 'text'), ...(position ? { position } : {}) }
      const before = getDoc(key).body.length
      const d = editDoc(key, e, { by: 'agent', reason, confirmLargeDeletion })
      logActivity('system', `An agent edited ${DOCS[key].title}`, { link: `/profile/${key}`, detail: reason })
      return { saved: true, chars: d.body.length, delta: d.body.length - before }
    }),
  ),

  tool(
    'list_profile_doc_revisions',
    'The history of a profile document, newest first: who changed it (user, agent or app), when, why, and the text each change removed and added (long text is cut short). Use a revision id with revert_profile_doc.',
    { key: docKey, limit: z.number().int().min(1).max(100).optional().describe('default 20') },
    safe(({ key, limit }) => ({ key, revisions: listRevisions(key, limit ?? 20) })),
    ro,
  ),

  tool(
    'revert_profile_doc',
    "Undo one revision of a profile document: puts back exactly the text it had before that change (the revert is itself a revision, so it can be undone too). If the document changed again after that revision, revert the later ones first, or pass overwriteLaterEdits to go back to that point and lose them. Only when the user asks, or to undo your own mistaken edit.",
    {
      revisionId: z.string(),
      reason: reason.optional(),
      overwriteLaterEdits: z.boolean().optional(),
      confirmLargeDeletion,
    },
    safe(({ revisionId, reason, overwriteLaterEdits, confirmLargeDeletion }) => {
      const d = revertRevision(revisionId, { by: 'agent', ...(reason ? { reason } : {}), overwriteLaterEdits, confirmLargeDeletion })
      logActivity('system', `An agent reverted a change to ${DOCS[d.key].title}`, { link: `/profile/${d.key}`, ...(reason ? { detail: reason } : {}) })
      return { reverted: revisionId, key: d.key, chars: d.body.length, isTemplate: d.isDefault }
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
