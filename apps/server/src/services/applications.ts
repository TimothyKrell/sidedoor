import { eq } from 'drizzle-orm'
import type { ResumeMatch } from '@sidedoor/shared/match'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { addDays, newId, nowIso, today } from '../ids'
import { getSettings } from '../settings'
import { enqueueTask } from './tasks'

export type AppPatch = Partial<Omit<typeof schema.applications.$inferInsert, 'id' | 'createdAt'>>

export const getApplication = (id: string) => db.select().from(schema.applications).where(eq(schema.applications.id, id)).get()

export const STAGE_LABEL: Record<schema.ApplicationStage, string> = {
  interested: 'Interested',
  review: 'Ready for review',
  approved: 'Approved to submit',
  applied: 'Applied',
  screening: 'Screening',
  interviewing: 'Interviewing',
  offer: 'Offer',
  closed: 'Closed',
}

/** Start tracking a posting. Optionally kicks off package prep and research. */
export const trackPosting = atomic((postingId: string, o: { prep?: boolean; research?: boolean; priority?: 'high' | 'medium' | 'low' } = {}) => {
  const p = db.select().from(schema.postings).where(eq(schema.postings.id, postingId)).get()
  if (!p) throw new Error(`No posting ${postingId}`)
  if (p.applicationId) {
    const existing = getApplication(p.applicationId)
    if (existing) return existing
  }
  const s = getSettings()
  const id = newId('app_')
  const prep = o.prep ?? s.prep.auto
  db.insert(schema.applications)
    .values({
      id,
      postingId: p.id,
      companyId: p.companyId,
      companyName: p.companyName ?? 'Unknown',
      role: p.title,
      stage: 'interested',
      status: 'potential',
      priority: o.priority ?? ((p.fitScore ?? 0) >= 85 ? 'high' : 'medium'),
      source: 'sidedoor scout',
      jobUrl: p.url,
      applyUrl: p.applyUrl ?? p.url,
      location: p.location,
      compText: p.compText,
      compMin: p.compMin,
      compMax: p.compMax,
      fitScore: p.fitScore,
      nextAction: prep ? 'Your AI is preparing the application' : 'Decide whether to apply',
      lastActivityAt: nowIso(),
    })
    .run()
  db.update(schema.postings).set({ applicationId: id, userStatus: 'tracked' }).where(eq(schema.postings.id, p.id)).run()
  const label = `${p.companyName ?? 'Unknown company'} – ${p.title}`
  if (prep) enqueueTask('prep', `Prepare package: ${label}`, { applicationId: id })
  if (o.research ?? s.research.auto) enqueueTask('research', `Research & people: ${label}`, { applicationId: id })
  logActivity('application', `Tracking ${label}`, { link: `/applications/${id}` })
  return getApplication(id)!
})

export const createApplication = atomic((v: Omit<typeof schema.applications.$inferInsert, 'id'>) => {
  const id = newId('app_')
  db.insert(schema.applications).values({ ...v, id, lastActivityAt: nowIso() }).run()
  logActivity('application', `Added ${v.companyName} – ${v.role}`, { link: `/applications/${id}` })
  return getApplication(id)!
})

export const updateApplication = atomic((id: string, patch: AppPatch) => {
  db.update(schema.applications).set({ ...patch, updatedAt: nowIso(), lastActivityAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  return getApplication(id)
})

/** Store a resume match check. It's a reading of the resume, not activity, so lastActivityAt stays. */
export const setResumeMatch = atomic((id: string, match: ResumeMatch | null) => {
  db.update(schema.applications).set({ matchJson: match, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  return getApplication(id)
})

/** Move through the pipeline, applying the bookkeeping each stage implies. */
export const setStage = atomic((id: string, stage: schema.ApplicationStage, o: { note?: string; closedReason?: string; won?: boolean } = {}) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const s = getSettings()
  const patch: AppPatch = { stage }
  switch (stage) {
    case 'applied':
      patch.status = 'active'
      patch.appliedAt = a.appliedAt ?? nowIso()
      patch.nextAction = 'Follow up if no response; reach out to the hiring manager'
      patch.nextActionDate = addDays(nowIso(), s.followups.afterApplyDays)
      break
    case 'screening':
    case 'offer':
      patch.status = 'active'
      break
    case 'interviewing':
      patch.status = 'active'
      patch.nextAction = 'Prepare for the interview'
      // Interview prep: questions they'll likely ask, your stories that answer them, who you'll meet.
      if (a.stage !== 'interviewing' && s.ai.default)
        enqueueTask('custom', `Interview prep: ${a.companyName} – ${a.role}`, {
          applicationId: id,
          priority: 8,
          input: {
            instructions: `Prepare me for interviews for application ${id} (${a.companyName} – ${a.role}). Read the application, its research and the posting (get_application). Then save a brief with save_research (title "Interview prep: ${a.companyName}") covering: what the team does and why they're hiring; the 8-10 questions they're most likely to ask, each with the story or fact from my Experience and Story bank that answers it best (say when I have no good answer); 3-5 smart questions for me to ask; and the people I may meet, with one line each. Facts about me only from my Experience document and Story bank.`,
          },
        })
      break
    case 'closed':
      patch.status = o.won ? 'closed-won' : 'closed-lost'
      patch.closedReason = o.closedReason ?? null
      patch.nextAction = null
      patch.nextActionDate = null
      break
    case 'review':
      patch.nextAction = 'Review the package and approve or request changes'
      patch.nextActionDate = today()
      break
    case 'approved':
      patch.nextAction = 'Submit the application'
      patch.nextActionDate = today()
      break
    default:
      break
  }
  const next = updateApplication(id, patch)
  logActivity('application', `${a.companyName} – ${a.role}: ${STAGE_LABEL[stage]}`, {
    ...(o.note ? { detail: o.note } : {}),
    link: `/applications/${id}`,
  })
  return next
})

/** Send a package back to the AI with the user's notes. */
export const requestChanges = atomic((id: string, notes: string) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  updateApplication(id, { reviewNotes: notes, nextAction: 'Your AI is revising the package' })
  enqueueTask('prep', `Revise package: ${a.companyName} – ${a.role}`, { applicationId: id, priority: 5, input: { revision: true } })
})

/** Point an application at a better link for its posting. Not activity, so the pipeline order stays put. */
export const relinkApplication = atomic((id: string, from: { links: string[]; location: string | null }, to: { jobUrl: string; applyUrl: string; location: string | null }) => {
  const a = getApplication(id)
  if (!a) return
  const patch: AppPatch = {}
  // Only replace fields that still match the old listing; a link or location the user set by hand stays.
  if (!a.jobUrl || from.links.includes(a.jobUrl)) patch.jobUrl = to.jobUrl
  if (!a.applyUrl || from.links.includes(a.applyUrl)) patch.applyUrl = to.applyUrl
  if (to.location && to.location !== a.location && (!a.location || a.location === from.location)) patch.location = to.location
  if (Object.keys(patch).length) db.update(schema.applications).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
})

/**
 * Two applications for the same role: fold `dupId` into `keepId`. People, touchpoints, drafts,
 * research, tasks and postings move over; fields the kept one lacks are filled from the duplicate;
 * the duplicate's notes are appended; the duplicate is closed, pointing at the one kept.
 */
export const mergeApplications = atomic((keepId: string, dupId: string) => {
  if (keepId === dupId) throw new Error('Pick two different applications')
  const keep = getApplication(keepId)
  const dup = getApplication(dupId)
  if (!keep) throw new Error(`No application ${keepId}`)
  if (!dup) throw new Error(`No application ${dupId}`)
  const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, dupId)).all()
  for (const l of links) db.insert(schema.applicationPeople).values({ applicationId: keepId, personId: l.personId, role: l.role }).onConflictDoNothing().run()
  db.delete(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, dupId)).run()
  db.update(schema.interactions).set({ applicationId: keepId }).where(eq(schema.interactions.applicationId, dupId)).run()
  db.update(schema.drafts).set({ applicationId: keepId }).where(eq(schema.drafts.applicationId, dupId)).run()
  db.update(schema.research).set({ applicationId: keepId }).where(eq(schema.research.applicationId, dupId)).run()
  db.update(schema.tasks).set({ applicationId: keepId }).where(eq(schema.tasks.applicationId, dupId)).run()
  db.update(schema.postings).set({ applicationId: keepId }).where(eq(schema.postings.applicationId, dupId)).run()
  const fill: AppPatch = {}
  const fields = ['postingId', 'companyId', 'jobUrl', 'applyUrl', 'location', 'compText', 'compMin', 'compMax', 'fitScore', 'appliedAt', 'packageMd', 'resumeId'] as const
  for (const k of fields) if (keep[k] == null && dup[k] != null) Object.assign(fill, { [k]: dup[k] })
  if (dup.notesMd?.trim()) fill.notesMd = `${keep.notesMd ? `${keep.notesMd}\n\n` : ''}**Merged from ${dup.companyName} – ${dup.role} (${dup.id}):**\n${dup.notesMd}`
  if (Object.keys(fill).length) updateApplication(keepId, fill)
  if (dup.stage !== 'closed') setStage(dupId, 'closed', { closedReason: `Duplicate of ${keepId}` })
  else updateApplication(dupId, { closedReason: `Duplicate of ${keepId}` })
  return getApplication(keepId)!
})
