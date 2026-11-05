import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { extractProseSections } from '@sidedoor/shared/package-sections'
import { logInjection } from '../activity'
import { runJob } from '../ai'
import { db, schema } from '../db/client'
import { experienceContext } from '../experience'
import { context, render } from '../prompts'
import { getApplication } from '../services/applications'
import { fenceUntrusted, noPostingText } from '../untrusted'
import { numbersIn, writingRules } from './tells'

export type AssistMode = 'draft' | 'cleanup'

const AssistOut = z.object({ text: z.string(), gaps: z.array(z.string()).default([]) })

/**
 * Help with one written answer, for the box on the Review page: draft it from the user's facts, or
 * tidy what they rambled in. Returns text for them to read and nothing is saved, so the words stay
 * theirs to change or throw away. One text call with no tools: it works only from what it's given.
 */
export const assistWriting = async (id: string, key: string, mode: AssistMode, text: string) => {
  const a = getApplication(id)
  if (!a?.packageMd) throw new Error('No package')
  const section = extractProseSections(a.packageMd, { all: true }).find((s) => s.key === key)
  if (!section) throw new Error('That answer changed; reload the package')
  const said = text.trim()
  if (mode === 'cleanup' && !said) throw new Error('Write something in the box first.')
  const common = { LEAD_NAME: `${a.companyName} – ${a.role}`, QUESTION: section.title, WRITING_RULES: writingRules() || '(no writing style set: plain, warm, short and specific)' }
  if (mode === 'cleanup') {
    const r = await runJob({ job: 'editor', prompt: render('write-cleanup', { ...common, TEXT: said }), schema: AssistOut, maxTurns: 3, timeoutMs: 5 * 60_000 })
    const out = r.data.text.trim()
    if (!out) throw new Error('Your AI came back with nothing. Your text is untouched.')
    // The one promise here is that it adds nothing, so a number they never said doesn't get through.
    const added = newNumbers(out, said)
    if (added.length) throw new Error(`The cleanup added numbers you didn't say (${added.join(', ')}), so your text is untouched. Try again.`)
    return { text: out, note: null }
  }
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const fenced = p?.jd ? fenceUntrusted(p.jd, { max: 14_000 }) : null
  if (fenced) logInjection(fenced.flags, { subject: common.LEAD_NAME, link: `/applications/${a.id}`, where: 'a written answer' })
  const experience = experienceContext(`${a.role}\n${section.title}\n${p?.jd ?? ''}`)
  const stories = context.stories()
  const r = await runJob({
    job: 'editor',
    prompt: render('write-draft', { ...common, NOTES: said || '(nothing yet)', EXPERIENCE: experience.text, STORIES: stories || '(none yet)', JD: fenced?.text ?? noPostingText('answer from the question alone') }),
    schema: AssistOut,
    maxTurns: 3,
    timeoutMs: 5 * 60_000,
  })
  const out = r.data.text.trim()
  if (!out) throw new Error('Your AI came back with nothing. Your text is untouched.')
  const unsure = newNumbers(out, `${said}\n${experience.text}\n${stories}\n${p?.jd ?? ''}\n${a.companyName} ${a.role}`)
  const notes = [unsure.length ? `Check these numbers, they aren't in your facts: ${unsure.join(', ')}.` : '', r.data.gaps.length ? `Your facts didn't cover: ${r.data.gaps.map((g) => g.replace(/[.\s]+$/, '')).join('; ')}.` : ''].filter(Boolean)
  return { text: out, note: notes.join(' ') || null }
}

const newNumbers = (text: string, known: string) => {
  const have = new Set(numbersIn(known))
  return [...new Set(numbersIn(text))].filter((n) => !have.has(n))
}
