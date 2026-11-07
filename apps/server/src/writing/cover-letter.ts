import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { extractProseSections, replaceSections } from '@sidedoor/shared/package-sections'
import { logInjection } from '../activity'
import { runJob } from '../ai'
import { db, schema } from '../db/client'
import { experienceContext } from '../experience'
import { context, render, template } from '../prompts'
import { getApplication, updateApplication } from '../services/applications'
import { fenceUntrusted, noPostingText } from '../untrusted'
import { numbersIn, voiceSamples } from './tells'

// The cover letter pass: a separate AI call after prep, like the editor. Prep's long run is about
// the resume and the form, and a letter written there reads like both. This one sees only the job,
// the facts and the user's own words, and rewrites prep's plain draft. No tools.

const CoverLetterOut = z.object({ letter: z.string() })

/** How a letter can sound: 'mine' is their own voice, the others are styles laid over it. */
export const LETTER_VOICES = ['mine', 'spunky', 'milady'] as const
export type LetterVoice = (typeof LETTER_VOICES)[number]

const letterOf = (md: string | null | undefined) => extractProseSections(md, { all: true }).find((s) => s.key === 'cover-letter')?.text

const write = async (a: schema.Application, draft: string, notes: string, voice: LetterVoice) => {
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const fenced = p?.jd ? fenceUntrusted(p.jd, { max: 14_000 }) : null
  const lead = `${a.companyName} – ${a.role}`
  if (fenced) logInjection(fenced.flags, { subject: lead, link: `/applications/${a.id}`, where: 'the cover letter' })
  const research = db.select().from(schema.research).where(eq(schema.research.applicationId, a.id)).orderBy(desc(schema.research.createdAt)).get()
  const experience = experienceContext(`${a.role}\n${p?.jd ?? ''}\n${draft}`)
  const stories = context.stories()
  const r = await runJob({
    job: 'editor',
    prompt: render('cover-letter', {
      LEAD_NAME: lead,
      JD: fenced?.text ?? noPostingText('go by the first draft'),
      RESEARCH: research?.bodyMd ?? '(none)',
      DRAFT: draft,
      STORIES: stories || '(none yet)',
      EXPERIENCE: experience.text,
      VOICE: voiceSamples(),
      STYLE: voice === 'mine' ? '' : `\n${template(`cover-letter-${voice}`)}`,
      REVIEW_NOTES: notes || '(none)',
    }),
    schema: CoverLetterOut,
    maxTurns: 3,
    timeoutMs: 10 * 60_000,
  })
  const letter = r.data.letter.trim()
  if (!letter) throw new Error('the AI came back with no letter')
  const known = new Set(numbersIn(`${draft}\n${experience.text}\n${stories}\n${p?.jd ?? ''}\n${research?.bodyMd ?? ''}\n${lead}`))
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
  const { letter, unsure } = await write(a, draft, o.notes ?? '', 'mine')
  updateApplication(a.id, { packageMd: replaceSections(a.packageMd, { 'cover-letter': letter }) })
  return { written: true, unsure }
}

/** The letter in another voice, for them to read. Nothing is saved, so flipping back costs nothing. */
export async function restyleCoverLetter(applicationId: string, voice: LetterVoice, text?: string) {
  const a = getApplication(applicationId)
  const draft = text?.trim() || letterOf(a?.packageMd)
  if (!a || !draft) throw new Error('There is no cover letter to rewrite yet.')
  const { letter, unsure } = await write(a, draft, '', voice)
  return { text: letter, note: unsure.length ? `Check these numbers, they aren't in your facts: ${unsure.join(', ')}.` : null }
}
