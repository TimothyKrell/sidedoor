import { z } from 'zod'
import { runJob } from '../ai'
import { logActivity } from '../activity'
import type { schema } from '../db/client'
import { render } from '../prompts'
import { appendDoc, isWritten, setDoc } from '../services/documents'
import { createResume, saveContent } from '../services/resumes'
import { getSettings, updateSettings } from '../settings'
import type { TaskOutcome } from './tasks'

/**
 * Turn a resume the user already has (text extracted from a PDF/DOCX upload, or pasted) into a
 * structured resume, fill in their contact details, and seed the Experience document. The AI only
 * restructures what's there; nothing is invented.
 */

const Line = z.object({ text: z.string() })
const ImportOut = z.object({
  basics: z.object({
    name: z.string(),
    headline: z.string().nullish(),
    location: z.string().nullish(),
    email: z.string().nullish(),
    phone: z.string().nullish(),
    links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  }),
  summary: z.string().nullish(),
  highlights: z.array(z.object({ value: z.string(), label: z.string() })).default([]),
  experience: z.array(
    z.object({
      company: z.string(),
      location: z.string().nullish(),
      roles: z.array(z.object({ title: z.string(), dates: z.string(), bullets: z.array(Line).default([]) })),
    }),
  ),
  skills: z.array(z.object({ label: z.string(), text: z.string() })).default([]),
  education: z.array(z.object({ school: z.string(), degree: z.string(), dates: z.string().nullish(), detail: z.string().nullish() })).default([]),
  other: z.array(z.object({ title: z.string(), items: z.array(Line) })).default([]),
  /** The Experience document seeded from the resume: markdown, facts only. */
  experience_md: z.string(),
  target_roles: z.array(z.string()).default([]),
  country: z.string().nullish(),
})

export const runImportResume = async (task: schema.Task): Promise<TaskOutcome> => {
  const text = typeof task.input.text === 'string' ? task.input.text : ''
  if (text.trim().length < 80) throw new Error('There is too little text in that file to import. Try a PDF with selectable text, or paste the resume.')
  const r = await runJob({ job: 'import', prompt: render('import-resume', { RESUME_TEXT: text.slice(0, 40_000) }), schema: ImportOut, maxTurns: 3, timeoutMs: 15 * 60_000 })
  const d = r.data
  const content = {
    version: 1 as const,
    basics: {
      name: d.basics.name,
      headline: d.basics.headline ? { id: '', text: d.basics.headline } : null,
      location: d.basics.location ?? '',
      email: d.basics.email ?? '',
      phone: d.basics.phone ?? '',
      links: d.basics.links,
    },
    highlights: d.highlights.map((h) => ({ id: '', ...h })),
    sections: [
      ...(d.summary ? [{ id: '', type: 'summary' as const, title: 'Summary', text: { id: '', text: d.summary } }] : []),
      {
        id: '',
        type: 'experience' as const,
        title: 'Experience',
        companies: d.experience.map((c) => ({
          id: '',
          name: c.company,
          ...(c.location ? { location: c.location } : {}),
          roles: c.roles.map((ro) => ({ id: '', title: ro.title, dates: ro.dates, bullets: ro.bullets.map((b) => ({ id: '', text: b.text })) })),
        })),
      },
      ...(d.skills.length ? [{ id: '', type: 'skills' as const, title: 'Skills', groups: d.skills.map((g) => ({ id: '', ...g })) }] : []),
      ...(d.education.length ? [{ id: '', type: 'education' as const, title: 'Education', items: d.education.map((e) => ({ id: '', school: e.school, degree: e.degree, ...(e.dates ? { dates: e.dates } : {}), ...(e.detail ? { detail: e.detail } : {}) })) }] : []),
      ...d.other.map((o) => ({ id: '', type: 'list' as const, title: o.title, items: o.items.map((i) => ({ id: '', text: i.text })) })),
    ],
  }
  const target = typeof task.input.resumeId === 'string' ? task.input.resumeId : null
  const resume = target ? saveContent(target, content, { by: 'user', reason: 'import' }).resume : createResume({ title: 'Main resume', content, theme: typeof task.input.theme === 'string' ? task.input.theme : 'modern' })
  // Fill in what onboarding hasn't asked yet; never overwrite what the user typed.
  const you = getSettings().you
  updateSettings('you', {
    name: you.name || d.basics.name,
    email: you.email || (d.basics.email ?? ''),
    phone: you.phone || (d.basics.phone ?? ''),
    location: you.location || (d.basics.location ?? ''),
    country: you.country || (d.country ?? ''),
    links: you.links.length ? you.links : d.basics.links,
  })
  if (!getSettings().search.roles.length && d.target_roles.length) updateSettings('search', { roles: d.target_roles.slice(0, 6) })
  if (isWritten('experience')) appendDoc('experience', `## Imported from resume\n\n${d.experience_md}`)
  else setDoc('experience', d.experience_md)
  logActivity('system', 'Imported your resume', { link: `/resume/${resume.id}` })
  return { output: JSON.stringify({ resumeId: resume.id, summary: `Imported ${d.experience.length} compan${d.experience.length === 1 ? 'y' : 'ies'} into ${resume.title}` }), provider: r.provider, model: r.model, log: r.log }
}
