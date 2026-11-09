import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { fillTemplate, markedTemplate, parseTemplate } from '@sidedoor/shared/letter-template'
import { extractProseSections, replaceSections } from '@sidedoor/shared/package-sections'
import { logInjection } from '../activity'
import { runJob } from '../ai'
import { db, schema } from '../db/client'
import { experienceContext } from '../experience'
import { context, render, template } from '../prompts'
import { getApplication, updateApplication } from '../services/applications'
import { fenceUntrusted, noPostingText } from '../untrusted'
import { defaultLetterTemplate, findLetterTemplate, type LetterTemplate } from './letter-templates'
import { numbersIn, voiceSamples } from './tells'

// The cover letter pass: a separate AI call after prep, like the editor. Prep's long run is about
// the resume and the form, and a letter written there reads like both. This one sees only the job,
// the facts and the user's own words, and rewrites prep's plain draft. No tools.

const CoverLetterOut = z.object({ letter: z.string() })
const TemplateOut = z.object({ slots: z.array(z.object({ n: z.coerce.number(), text: z.string() })) })

/** How a letter can sound: 'mine' is their own voice, the others are styles laid over it. */
export const LETTER_VOICES = ['mine', 'spunky', 'milady'] as const
export type LetterVoice = (typeof LETTER_VOICES)[number]

const letterOf = (md: string | null | undefined) => extractProseSections(md, { all: true }).find((s) => s.key === 'cover-letter')?.text

/** How to write it: freely in a voice, or by filling one of their templates. */
type How = { voice: LetterVoice } | { template: LetterTemplate }

const write = async (a: schema.Application, draft: string, notes: string, how: How) => {
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const fenced = p?.jd ? fenceUntrusted(p.jd, { max: 14_000 }) : null
  const lead = `${a.companyName} – ${a.role}`
  if (fenced) logInjection(fenced.flags, { subject: lead, link: `/applications/${a.id}`, where: 'the cover letter' })
  const research = db.select().from(schema.research).where(eq(schema.research.applicationId, a.id)).orderBy(desc(schema.research.createdAt)).get()
  const experience = experienceContext(`${a.role}\n${p?.jd ?? ''}\n${draft}`)
  const stories = context.stories()
  const vars = {
    LEAD_NAME: lead,
    JD: fenced?.text ?? noPostingText('go by the first draft'),
    RESEARCH: research?.bodyMd ?? '(none)',
    DRAFT: draft || '(none yet)',
    STORIES: stories || '(none yet)',
    EXPERIENCE: experience.text,
    VOICE: voiceSamples(),
    REVIEW_NOTES: notes || '(none)',
  }
  let letter: string
  let theirs = ''
  if ('template' in how) {
    // The AI writes only the slots; their own text is put back around them here, so it stays exact.
    const parts = parseTemplate(how.template.body)
    theirs = parts.map((p) => p.text).join('\n')
    const r = await runJob({ job: 'editor', prompt: render('cover-letter-template', { ...vars, TEMPLATE: markedTemplate(parts) }), schema: TemplateOut, maxTurns: 3, timeoutMs: 10 * 60_000 })
    const filled = fillTemplate(parts, new Map(r.data.slots.map((x) => [x.n, x.text])))
    if (filled.missing.length) throw new Error(`the AI left part of the template empty (${filled.missing.map((n) => `#${n}`).join(', ')})`)
    letter = filled.text
  } else {
    const r = await runJob({
      job: 'editor',
      prompt: render('cover-letter', { ...vars, STYLE: how.voice === 'mine' ? '' : `\n${template(`cover-letter-${how.voice}`)}` }),
      schema: CoverLetterOut,
      maxTurns: 3,
      timeoutMs: 10 * 60_000,
    })
    letter = r.data.letter.trim()
  }
  if (!letter) throw new Error('the AI came back with no letter')
  const known = new Set(numbersIn(`${draft}\n${theirs}\n${experience.text}\n${stories}\n${p?.jd ?? ''}\n${research?.bodyMd ?? ''}\n${lead}`))
  return { letter, unsure: [...new Set(numbersIn(letter))].filter((n) => !known.has(n)) }
}

/**
 * Rewrite the package's cover letter. `before` is the package prep started from: a revision that
 * left the letter as it was keeps it, so a letter they've worked on isn't written over.
 */
export async function writeCoverLetter(applicationId: string, o: { notes?: string; before?: string | null } = {}) {
  const a = getApplication(applicationId)
  const draft = letterOf(a?.packageMd)
  if (!a?.packageMd || !draft || draft.length < 80 || /^_?not requested/i.test(draft) || draft === letterOf(o.before)) return { written: false, unsure: [] as string[] }
  const t = defaultLetterTemplate()
  const { letter, unsure } = await write(a, draft, o.notes ?? '', t ? { template: t } : { voice: 'mine' })
  updateApplication(a.id, { packageMd: replaceSections(a.packageMd, { 'cover-letter': letter }) })
  return { written: true, unsure }
}

/**
 * The letter in another voice, or written from one of their templates, for them to read. Nothing
 * is saved, so flipping back costs nothing. A template needs no letter to start from.
 */
export async function restyleCoverLetter(applicationId: string, how: { voice?: LetterVoice; template?: string }, text?: string) {
  const a = getApplication(applicationId)
  const draft = text?.trim() || letterOf(a?.packageMd) || ''
  const t = how.template ? findLetterTemplate(how.template) : undefined
  if (how.template && !t) throw new Error('That cover letter template no longer exists.')
  if (!a || (!t && !draft)) throw new Error('There is no cover letter to rewrite yet.')
  const usable = /^_?not requested/i.test(draft) ? '' : draft
  const { letter, unsure } = await write(a, usable, '', t ? { template: t } : { voice: how.voice ?? 'mine' })
  return { text: letter, note: unsure.length ? `Check these numbers, they aren't in your facts: ${unsure.join(', ')}.` : null }
}
