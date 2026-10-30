import { and, desc, eq, inArray, isNotNull, notInArray } from 'drizzle-orm'
import type { ResumeMatch } from '@sidedoor/shared/match'
import { blockingFindings } from '@sidedoor/shared/rules'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { addDays, newId, nowIso, today } from '../ids'
import { getSettings } from '../settings'
import { appendDoc } from './documents'
import { checkApplicationRules } from './rules'
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
  // Check the user's rules now, so a role that breaks them shows it before anyone preps it.
  checkApplicationRules(id)
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
  // A rank orders one stage's column; it means nothing in the next one.
  const patch: AppPatch = stage === a.stage ? { stage } : { stage, rank: null }
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

/**
 * Put applications in order, best first. The ones named get ranks 1..n in that order; any other
 * ranked application in the same stages moves after them, keeping its order. Like the score below,
 * a ranking is a judgment about the application, not activity on it, so lastActivityAt stays.
 */
export const rankApplications = atomic((ids: string[]) => {
  const A = schema.applications
  const rows = ids.length ? db.select({ id: A.id, stage: A.stage }).from(A).where(inArray(A.id, ids)).all() : []
  const missing = ids.filter((id) => !rows.some((r) => r.id === id))
  if (missing.length) throw new Error(`No application ${missing.join(', ')}`)
  const stages = [...new Set(rows.map((r) => r.stage))]
  const rest = stages.length
    ? db.select({ id: A.id, rank: A.rank }).from(A).where(and(inArray(A.stage, stages), isNotNull(A.rank), notInArray(A.id, ids))).all().sort((x, y) => (x.rank ?? 0) - (y.rank ?? 0))
    : []
  const order = [...new Set(ids)].concat(rest.map((r) => r.id))
  order.forEach((id, i) => db.update(A).set({ rank: i + 1, updatedAt: nowIso() }).where(eq(A.id, id)).run())
  return order.length
})

/** Take applications out of the ranking; they sort with the unranked ones again. */
export const unrankApplications = atomic((ids: string[]) => {
  if (ids.length) db.update(schema.applications).set({ rank: null, updatedAt: nowIso() }).where(inArray(schema.applications.id, ids)).run()
})

/** Your AI's estimate of the chance an application gets you an interview. */
export const setShot = atomic((id: string, shot: number | null, why: string | null) => {
  db.update(schema.applications).set({ shot: shot == null ? null : Math.max(0, Math.min(100, Math.round(shot))), shotWhy: why, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  return getApplication(id)
})

/** Stages an application is still waiting to go in. */
const UNSENT: schema.ApplicationStage[] = ['interested', 'review', 'approved']

/**
 * Grok Bot asks for an application to go in: approve it if it isn't yet, and queue the fill that
 * submits it (jobs/fill-form.ts). A fill already waiting for it becomes the one that submits.
 * A dry run fills and reports the questions without approving or submitting anything.
 */
export const requestSubmit = atomic((id: string, o: { dryRun?: boolean; skipRuleCheck?: boolean } = {}) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  if (a.appliedAt || !UNSENT.includes(a.stage)) throw new Error(`${a.companyName} – ${a.role} is ${STAGE_LABEL[a.stage]}${a.appliedAt ? `, applied ${a.appliedAt.slice(0, 10)}` : ''}: nothing to submit.`)
  if (!a.packageMd) throw new Error('No application package yet. Prepare it first (start_task prep) and submit once it is saved.')
  const url = a.applyUrl ?? a.jobUrl
  if (!url) throw new Error('This application has no apply URL. Set applyUrl with update_application first.')
  if (url.startsWith('mailto:')) throw new Error('This job takes applications by email, not a form. Draft the email instead; the user sends it.')
  const T = schema.tasks
  const open = db.select().from(T).where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, id), inArray(T.status, ['queued', 'running']))).get()
  if (open?.status === 'running' && open.input.submit !== true) throw new Error('A fill for the user to review is running for this one now. Ask again once it is done.')
  const dryRun = o.dryRun === true
  // The user's rules: a fail nobody overrode stops a submit. A dry run never submits, so it may go ahead.
  if (!dryRun && !o.skipRuleCheck) {
    const block = blockingFindings(checkApplicationRules(id))
    if (block.length)
      throw new Error(
        `Not submitting ${a.companyName} – ${a.role}: it breaks the user's rules. ${block.map((f) => `${f.reason}${f.quote ? ` ("${f.quote}")` : ''}`).join('; ')}. Ask the user; only if they want it anyway, call override_rules, then submit again.`,
      )
  }
  if (!dryRun && a.stage !== 'approved') setStage(id, 'approved', { note: 'Approved by Grok Bot to submit' })
  const input = { submit: true, by: 'grokbot', dryRun }
  let task: schema.Task
  if (open) {
    db.update(T).set({ input: { ...open.input, ...input } }).where(eq(T.id, open.id)).run()
    task = { ...open, input: { ...open.input, ...input } }
  } else task = enqueueTask('submit-assist', `${dryRun ? 'Dry run' : 'Submit'}: ${a.companyName} – ${a.role}`, { applicationId: id, priority: 10, input })
  updateApplication(id, { nextAction: dryRun ? 'Sidedoor is filling this for Grok Bot (dry run: no submit)' : 'Sidedoor is filling and submitting this for Grok Bot' })
  return task
})

export interface FormAnswer {
  question: string
  answer: string
  /** True when it's about the user, not this job (salary, start date, relocation): saved to Standard answers too. */
  reusable?: boolean
}

const ANSWERS_HEADING = '## Answers to the other form questions'

/**
 * The user's answers to questions a form asked that the package didn't cover. They go into the
 * package (what the form filler pastes from), the ones that apply to any job into Standard
 * answers, and the application is sent to be filled again: submitted, or another dry run when
 * that's what it was last sent for.
 */
export const answerFormQuestions = atomic((id: string, answers: FormAnswer[]) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const given = answers.map((x) => ({ ...x, question: x.question.trim(), answer: x.answer.trim() })).filter((x) => x.question && x.answer)
  if (!given.length) throw new Error('Give at least one question with its answer.')
  const block = given.map((x) => `### ${x.question}\n${x.answer}`).join('\n\n')
  const pkg = (a.packageMd ?? '').replace(/\s*$/, '')
  updateApplication(id, { packageMd: pkg.includes(ANSWERS_HEADING) ? `${pkg}\n\n${block}\n` : `${pkg}${pkg ? '\n\n' : ''}${ANSWERS_HEADING}\n\n${block}\n` })
  const keep = given.filter((x) => x.reusable)
  if (keep.length) appendDoc('answers', keep.map((x) => `- **${x.question}** ${x.answer}`).join('\n'))
  logActivity('application', `Answered ${given.length} form question${given.length === 1 ? '' : 's'}: ${a.companyName} – ${a.role}`, { link: `/applications/${id}` })
  const T = schema.tasks
  const last = db.select().from(T).where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, id))).orderBy(desc(T.createdAt)).get()
  // The fill checks the rules again before it clicks submit; failing here would lose the answers.
  return requestSubmit(id, { dryRun: last?.input.dryRun === true, skipRuleCheck: true })
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
