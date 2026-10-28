import { tool } from './define'
import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { logActivity } from '../activity'
import { companySlug, domainOf, ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { newId, nowIso, today } from '../ids'
import { notifyPromise } from '../notify'
import { Effect } from 'effect'
import { ADAPTERS, detectAts, fetchText, probeBoard, type RawJob } from '../scout/adapters'
import { companyBoard, normTitle } from '../scout/resolve'
import {
  createApplication,
  getApplication,
  mergeApplications,
  setStage,
  STAGE_LABEL,
  trackPosting,
  updateApplication,
} from '../services/applications'
import { findEmailFor } from '../services/email-finder'
import {
  createDraft,
  deleteInteraction,
  discardDraft,
  getPerson,
  linkPerson,
  logInteraction,
  markDraftSent,
  markEmailBounced,
  reopenDraft,
  scheduleFollowup,
  setRetryEmail,
  unlinkPerson,
  updateDraft,
  updatePerson,
  upsertPerson,
} from '../services/people'
import { cancelTask, enqueueTask, retryTask } from '../services/tasks'
import { setMeta } from '../settings'
import { parseComp, truncate } from '../text'
import { paths } from '../config'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { STRONG_WEIGHT, strongHits } from '@sidedoor/shared/tells'
import { checkTells, loadTellRules } from '../writing/tells'
import { appendStory } from '../writing/stories'
import { profileTools } from './profile-tools'

export const ok = (v: unknown) => ({ content: [{ type: 'text' as const, text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] })
export const fail = (msg: string) => ({ content: [{ type: 'text' as const, text: `Error: ${msg}` }], isError: true })

export const safe =
  <A,>(fn: (args: A) => unknown) =>
  async (args: A) => {
    try {
      return ok(await fn(args))
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }

const ro = { annotations: { readOnlyHint: true } }
const stageEnum = z.enum(schema.APPLICATION_STAGES)
const kindEnum = z.enum(schema.PERSON_KINDS)

const postingBrief = (p: schema.Posting) => ({
  id: p.id,
  company: p.companyName,
  title: p.title,
  location: p.location,
  postedAt: p.postedAt,
  firstSeenAt: p.firstSeenAt,
  fit: p.fitScore,
  decision: p.decision,
  summary: p.summary,
  comp: p.compText,
  url: p.url,
  status: p.userStatus,
  applicationId: p.applicationId,
  closed: !!p.closedAt,
})

const appBrief = (a: schema.Application) => ({
  id: a.id,
  company: a.companyName,
  role: a.role,
  stage: a.stage,
  status: a.status,
  priority: a.priority,
  fit: a.fitScore,
  nextAction: a.nextAction,
  nextActionDate: a.nextActionDate,
  appliedAt: a.appliedAt,
  url: a.jobUrl,
})

/** Every other application at the same company, so a second application to one employer is never an accident. */
const siblingApps = (a: Pick<schema.Application, 'id' | 'companyId' | 'companyName'>) =>
  db
    .select()
    .from(schema.applications)
    .where(and(ne(schema.applications.id, a.id), a.companyId ? or(eq(schema.applications.companyId, a.companyId), eq(schema.applications.companyName, a.companyName)) : eq(schema.applications.companyName, a.companyName)))
    .all()
    .map((x) => ({ id: x.id, role: x.role, stage: x.stage, status: x.status, appliedAt: x.appliedAt, closedReason: x.closedReason, url: x.jobUrl }))

const personBrief = (p: schema.Person) => ({
  id: p.id,
  name: p.name,
  company: p.companyName,
  title: p.title,
  kind: p.kind,
  email: p.email,
  emailConfidence: p.emailConfidence,
  linkedin: p.linkedin,
  x: p.x,
  stage: p.stage,
  lastContactAt: p.lastContactAt,
  nextContactAt: p.nextContactAt,
  nextAction: p.nextAction,
})

/**
 * The job board behind a custom careers page: an ATS board or RSS feed its HTML links to, else an
 * ATS board under the company's name. A guessed board may be a namesake's or a stale one, so it
 * comes back as a candidate for the agent to check against the careers page.
 */
const boardBehind = async (url: string, companyName?: string): Promise<{ kind: string; board: string; guessed: boolean; jobs?: number } | null> => {
  const html = await Effect.runPromise(fetchText(url).pipe(Effect.orElseSucceed(() => '')))
  const linked = [...html.matchAll(/https?:\/\/[^"'\s<>]+/g)].map((m) => detectAts(m[0].replace(/api\.ashbyhq\.com\/posting-api\/job-board/, 'jobs.ashbyhq.com').replace(/boards-api\.greenhouse\.io\/v1\/boards/, 'boards.greenhouse.io'))).find((d) => d !== null)
  if (linked) return { ...linked, guessed: false }
  const feed = html.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i)?.[0].match(/href=["']([^"']+)["']/i)?.[1]
  if (feed) return { kind: 'rss', board: new URL(feed, url).toString(), guessed: false }
  const slug = (companyName ?? domainOf(url)?.split('.')[0] ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const probed = slug ? await Effect.runPromise(probeBoard(slug)) : null
  return probed?.jobs.length ? { kind: probed.kind, board: probed.board, guessed: true, jobs: probed.jobs.length } : null
}

export const appTools = [
  tool(
    'pipeline_overview',
    "Snapshot of the user's whole job hunt: applications by stage, follow-ups due, packages awaiting review, newest strong postings, running AI tasks. Call this first when asked what's going on.",
    {},
    safe(() => {
      const byStage = db.select({ stage: schema.applications.stage, n: sql<number>`count(*)` }).from(schema.applications).where(inArray(schema.applications.status, ['potential', 'active', 'on-hold'])).groupBy(schema.applications.stage).all()
      const t = today()
      const dueApps = db.select().from(schema.applications).where(and(isNotNull(schema.applications.nextActionDate), lte(schema.applications.nextActionDate, t), inArray(schema.applications.status, ['potential', 'active']))).orderBy(schema.applications.nextActionDate).limit(25).all()
      const duePeople = db.select().from(schema.people).where(and(isNotNull(schema.people.nextContactAt), lte(schema.people.nextContactAt, t))).orderBy(schema.people.nextContactAt).limit(25).all()
      const review = db.select().from(schema.applications).where(inArray(schema.applications.stage, ['review', 'approved'])).all()
      const since = new Date(Date.now() - 72 * 3600_000).toISOString()
      const hot = db.select().from(schema.postings).where(and(gte(schema.postings.firstSeenAt, since), gte(schema.postings.fitScore, 60), isNull(schema.postings.closedAt))).orderBy(desc(schema.postings.fitScore)).limit(15).all()
      const running = db.select().from(schema.tasks).where(inArray(schema.tasks.status, ['queued', 'running'])).all()
      return {
        today: t,
        applicationsByStage: Object.fromEntries(byStage.map((r) => [r.stage, r.n])),
        applicationFollowupsDue: dueApps.map(appBrief),
        peopleFollowupsDue: duePeople.map(personBrief),
        awaitingReviewOrSubmit: review.map(appBrief),
        strongPostingsLast72h: hot.map(postingBrief),
        aiTasks: running.map((x) => ({ id: x.id, kind: x.kind, title: x.title, status: x.status })),
      }
    }),
    ro,
  ),

  tool(
    'search_postings',
    'Search scouted job postings. Defaults to open postings, newest first.',
    {
      query: z.string().optional().describe('matches company or title'),
      minFit: z.number().optional(),
      sinceHours: z.number().optional().describe('only postings first seen in the last N hours'),
      decision: z.enum(['queue', 'maybe', 'skip']).optional(),
      includeClosed: z.boolean().optional(),
      limit: z.number().max(100).optional(),
    },
    safe((a) => {
      const c = [isNotNull(schema.postings.triagedAt)]
      if (!a.includeClosed) c.push(isNull(schema.postings.closedAt))
      if (a.query) c.push(or(like(schema.postings.companyName, `%${a.query}%`), like(schema.postings.title, `%${a.query}%`))!)
      if (a.minFit) c.push(gte(schema.postings.fitScore, a.minFit))
      if (a.decision) c.push(eq(schema.postings.decision, a.decision))
      if (a.sinceHours) c.push(gte(schema.postings.firstSeenAt, new Date(Date.now() - a.sinceHours * 3600_000).toISOString()))
      return db.select().from(schema.postings).where(and(...c)).orderBy(desc(schema.postings.firstSeenAt)).limit(a.limit ?? 30).all().map(postingBrief)
    }),
    ro,
  ),

  tool(
    'get_posting',
    'Full detail for one posting, including the job description and triage reasoning.',
    { id: z.string() },
    safe(({ id }) => {
      const p = db.select().from(schema.postings).where(eq(schema.postings.id, id)).get()
      if (!p) throw new Error('not found')
      return { ...postingBrief(p), applyUrl: p.applyUrl, reasons: p.reasons, gaps: p.gaps, lane: p.lane, jd: truncate(p.jd, 14_000) }
    }),
    ro,
  ),

  tool(
    'track_posting',
    'Start pursuing a posting: creates an application and (by default) queues the AI to build the application package and research the company/people.',
    { postingId: z.string(), prep: z.boolean().optional(), research: z.boolean().optional() },
    safe((a) => appBrief(trackPosting(a.postingId, { ...(a.prep !== undefined ? { prep: a.prep } : {}), ...(a.research !== undefined ? { research: a.research } : {}) }))),
  ),

  tool(
    'set_posting_status',
    'Star or dismiss a posting in the feed.',
    { postingId: z.string(), status: z.enum(['new', 'starred', 'dismissed']) },
    safe((a) => {
      db.update(schema.postings).set({ userStatus: a.status }).where(eq(schema.postings.id, a.postingId)).run()
      return 'ok'
    }),
  ),

  tool(
    'list_applications',
    'List applications (roles the user is pursuing). Filter by stage or text.',
    { stage: stageEnum.optional(), query: z.string().optional(), includeClosed: z.boolean().optional() },
    safe((a) => {
      const c = []
      if (a.stage) c.push(eq(schema.applications.stage, a.stage))
      if (!a.includeClosed) c.push(inArray(schema.applications.status, ['potential', 'active', 'on-hold']))
      if (a.query) c.push(or(like(schema.applications.companyName, `%${a.query}%`), like(schema.applications.role, `%${a.query}%`))!)
      return db.select().from(schema.applications).where(and(...c)).orderBy(desc(schema.applications.lastActivityAt)).limit(80).all().map(appBrief)
    }),
    ro,
  ),

  tool(
    'get_application',
    'Everything about one application: package, notes, linked people, interaction history, drafts, research, its background tasks, its last resume match check (per-requirement levels and the resume line ids behind them), and every other application at the same company (check those before suggesting they apply).',
    { id: z.string() },
    safe(async ({ id }) => {
      const a = getApplication(id)
      if (!a) throw new Error('not found')
      const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, id)).all()
      const people = links.length ? db.select().from(schema.people).where(inArray(schema.people.id, links.map((l) => l.personId))).all() : []
      return {
        ...appBrief(a),
        postingId: a.postingId,
        source: a.source,
        closedReason: a.closedReason,
        location: a.location,
        comp: a.compText,
        applyUrl: a.applyUrl,
        resumeId: a.resumeId,
        reviewNotes: a.reviewNotes,
        notes: truncate(a.notesMd, 6000),
        package: truncate(a.packageMd, 12_000),
        people: people.map((p) => ({ ...personBrief(p), role: links.find((l) => l.personId === p.id)?.role })),
        interactions: db.select().from(schema.interactions).where(eq(schema.interactions.applicationId, id)).orderBy(desc(schema.interactions.at)).limit(30).all(),
        drafts: db.select().from(schema.drafts).where(eq(schema.drafts.applicationId, id)).all(),
        research: db.select({ id: schema.research.id, title: schema.research.title, body: schema.research.bodyMd }).from(schema.research).where(eq(schema.research.applicationId, id)).all().map((r) => ({ ...r, body: truncate(r.body, 6000) })),
        tasks: db.select({ id: schema.tasks.id, kind: schema.tasks.kind, status: schema.tasks.status, title: schema.tasks.title, finishedAt: schema.tasks.finishedAt, error: schema.tasks.error }).from(schema.tasks).where(eq(schema.tasks.applicationId, id)).orderBy(desc(schema.tasks.createdAt)).limit(10).all(),
        otherApplicationsAtCompany: siblingApps(a),
        resumeMatch: (await import('../match')).matchForAgent(a),
      }
    }),
    ro,
  ),

  tool(
    'create_application',
    'Track a role that did not come from the scout (e.g. a recruiter pitch or a referral). Returns any other applications at the same company: if one is the same role, use update_application or merge_applications instead of keeping two.',
    {
      companyName: z.string(),
      role: z.string(),
      jobUrl: z.string().optional().describe("the company's own ATS listing when there is one, not an aggregator repost"),
      applyUrl: z.string().optional(),
      stage: stageEnum.optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      source: z.string().optional(),
      location: z.string().optional(),
      compText: z.string().optional(),
      notesMd: z.string().optional(),
      nextAction: z.string().optional(),
      nextActionDate: z.string().optional().describe('YYYY-MM-DD'),
    },
    safe((a) => {
      const company = ensureCompany(a.companyName, { domain: domainOf(a.jobUrl) })
      const comp = parseComp(a.compText)
      const created = createApplication({
          companyId: company.id,
          companyName: company.name,
          role: a.role,
          stage: a.stage ?? 'interested',
          status: 'potential',
          priority: a.priority ?? 'medium',
          jobUrl: a.jobUrl ?? null,
          applyUrl: a.applyUrl ?? a.jobUrl ?? null,
          source: a.source ?? 'chat',
          location: a.location ?? null,
          compText: a.compText ?? null,
          compMin: comp.min,
          compMax: comp.max,
          notesMd: a.notesMd ?? null,
          nextAction: a.nextAction ?? null,
          nextActionDate: a.nextActionDate ?? null,
        })
      return { ...appBrief(created), otherApplicationsAtCompany: siblingApps(created) }
    }),
  ),

  tool(
    'update_application',
    'Change an application. Setting stage applies pipeline bookkeeping (e.g. applied → schedules follow-up). appendNote adds a dated line to its notes; notes replaces them. To change the package (cover letter, answers) use save_package.',
    {
      id: z.string(),
      stage: stageEnum.optional(),
      status: z.enum(['potential', 'active', 'on-hold', 'closed-won', 'closed-lost']).optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      nextAction: z.string().optional(),
      nextActionDate: z.string().nullable().optional().describe('YYYY-MM-DD or null'),
      appendNote: z.string().optional(),
      closedReason: z.string().optional(),
      role: z.string().optional(),
      location: z.string().optional(),
      compText: z.string().optional().describe('pay as listed, e.g. "$200K – $300K + equity"; min/max are parsed from it'),
      fitScore: z.number().min(0).max(100).optional(),
      jobUrl: z.string().optional().describe("the posting's URL; use the company's own ATS listing, not an aggregator repost"),
      applyUrl: z.string().optional(),
      notes: z.string().optional().describe('replaces all notes; prefer appendNote'),
    },
    safe((a) => {
      const cur = getApplication(a.id)
      if (!cur) throw new Error('not found')
      if (a.stage && a.stage !== cur.stage) setStage(a.id, a.stage, { ...(a.closedReason ? { closedReason: a.closedReason } : {}), won: a.status === 'closed-won' })
      const patch: Parameters<typeof updateApplication>[1] = {}
      if (a.status) patch.status = a.status
      if (a.priority) patch.priority = a.priority
      if (a.nextAction !== undefined) patch.nextAction = a.nextAction
      if (a.nextActionDate !== undefined) patch.nextActionDate = a.nextActionDate
      if (a.closedReason && !a.stage) patch.closedReason = a.closedReason
      if (a.role) patch.role = a.role
      if (a.location) patch.location = a.location
      if (a.compText) {
        const c = parseComp(a.compText)
        Object.assign(patch, { compText: a.compText, compMin: c.min, compMax: c.max })
      }
      if (a.fitScore !== undefined) patch.fitScore = a.fitScore
      if (a.jobUrl) patch.jobUrl = a.jobUrl
      if (a.applyUrl) patch.applyUrl = a.applyUrl
      if (a.notes !== undefined) patch.notesMd = a.notes
      if (a.appendNote) {
        const base = patch.notesMd ?? cur.notesMd
        patch.notesMd = `${base ? `${base}\n` : ''}- **${today()}:** ${a.appendNote}`
      }
      const next = Object.keys(patch).length ? updateApplication(a.id, patch) : getApplication(a.id)
      return { ...appBrief(next!), applyUrl: next!.applyUrl, location: next!.location, comp: next!.compText }
    }),
  ),

  tool(
    'search_people',
    'Search the user’s contacts (recruiters, hiring managers, founders, referrals).',
    { query: z.string().optional(), company: z.string().optional(), kind: kindEnum.optional(), followupDue: z.boolean().optional() },
    safe((a) => {
      const c = []
      if (a.query) c.push(or(like(schema.people.name, `%${a.query}%`), like(schema.people.companyName, `%${a.query}%`), like(schema.people.title, `%${a.query}%`))!)
      if (a.company) c.push(like(schema.people.companyName, `%${a.company}%`))
      if (a.kind) c.push(eq(schema.people.kind, a.kind))
      if (a.followupDue) c.push(and(isNotNull(schema.people.nextContactAt), lte(schema.people.nextContactAt, today()))!)
      return db.select().from(schema.people).where(and(...c)).orderBy(desc(schema.people.updatedAt)).limit(60).all().map(personBrief)
    }),
    ro,
  ),

  tool(
    'get_person',
    'One contact with notes, interaction history and drafts.',
    { id: z.string() },
    safe(({ id }) => {
      const p = getPerson(id)
      if (!p) throw new Error('not found')
      return {
        ...personBrief(p),
        why: p.whyMd,
        notes: truncate(p.notesMd, 6000),
        interactions: db.select().from(schema.interactions).where(eq(schema.interactions.personId, id)).orderBy(desc(schema.interactions.at)).limit(40).all(),
        drafts: db.select().from(schema.drafts).where(eq(schema.drafts.personId, id)).all(),
      }
    }),
    ro,
  ),

  tool(
    'upsert_person',
    'Create or update a contact. Matches existing people by email, LinkedIn, X handle, or name+company. Always cite where you found them in emailSource / whyMd. Optionally link to an application with a role (hiring-manager, recruiter, referrer, team-member).',
    {
      name: z.string(),
      companyName: z.string().optional(),
      title: z.string().optional(),
      kind: kindEnum.optional(),
      email: z.string().optional(),
      emailConfidence: z.enum(['verified', 'published', 'pattern', 'guessed']).optional(),
      emailSource: z.string().optional(),
      linkedin: z.string().optional(),
      x: z.string().optional().describe('X/Twitter handle or profile URL, e.g. @jane or https://x.com/jane'),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      nextAction: z.string().optional(),
      nextContactAt: z.string().optional().describe('YYYY-MM-DD'),
      whyMd: z.string().optional().describe('why this person matters + outreach hook, with sources'),
      applicationId: z.string().optional(),
      role: z.string().optional(),
    },
    safe(({ applicationId, role, ...p }) => {
      const clean = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as typeof p
      return personBrief(upsertPerson(clean, { ...(applicationId ? { applicationId } : {}), ...(role ? { role } : {}) }))
    }),
  ),

  tool(
    'link_person',
    'Attach an existing contact to an application.',
    { applicationId: z.string(), personId: z.string(), role: z.string().optional() },
    safe((a) => {
      linkPerson(a.applicationId, a.personId, a.role)
      return 'ok'
    }),
  ),

  tool(
    'log_interaction',
    'Record a touchpoint (the user emailed someone, they replied, a call happened, or a note). Outbound contact automatically schedules the next follow-up.',
    {
      personId: z.string().optional(),
      applicationId: z.string().optional(),
      channel: z.enum(['email', 'linkedin', 'call', 'meeting', 'text', 'x', 'other']),
      direction: z.enum(['out', 'in', 'note']),
      summary: z.string(),
      at: z.string().optional().describe('ISO time; defaults to now'),
      nextContactInDays: z.number().optional(),
    },
    safe((a) => {
      logInteraction({ ...a, personId: a.personId ?? null, applicationId: a.applicationId ?? null, nextContactInDays: a.nextContactInDays ?? null })
      return 'logged'
    }),
  ),

  tool(
    'schedule_followup',
    'Set when the user should next follow up with a person or on an application, and what to do. date null clears the follow-up.',
    { personId: z.string().optional(), applicationId: z.string().optional(), date: z.string().nullable().describe('YYYY-MM-DD, or null to clear'), action: z.string().nullable().optional() },
    safe((a) => {
      scheduleFollowup(a)
      return 'scheduled'
    }),
  ),

  tool(
    'create_draft',
    'Save an outreach draft for the user to review and send themselves (never sent automatically). Keep emails short, specific, in the user’s voice.',
    {
      personId: z.string().optional(),
      applicationId: z.string().optional(),
      channel: z.enum(['email', 'linkedin', 'x', 'other']).optional(),
      toEmail: z.string().optional(),
      subject: z.string().optional(),
      body: z.string(),
    },
    safe((a) => {
      const d = createDraft({ ...a, personId: a.personId ?? null, applicationId: a.applicationId ?? null, toEmail: a.toEmail ?? null, subject: a.subject ?? null })
      return { draftId: d.id }
    }),
  ),

  tool(
    'find_email',
    'Find likely email addresses for a person at a company domain, best first: their own address in the company\'s public GitHub commits, Hunter.io (when configured, also verifies the top guesses), the company\'s known pattern, patterns seen in public commits (with counts), then common patterns (only if the domain has MX records). Skips addresses that already bounced for this person and ranks formats that bounced for others at the company last. A bounce can also mean the person left the company; check before trying again. Also returns `evidence`: real addresses found at the domain. Use the first candidate and copy its confidence and source exactly; "guessed" stays guessed.',
    { name: z.string(), domain: z.string(), companyName: z.string().optional(), githubOrg: z.string().optional().describe('GitHub org if it is not the domain name, e.g. "workos"') },
    safe(async (a) => {
      const company = a.companyName ? ensureCompany(a.companyName, { domain: a.domain }) : null
      return findEmailFor({ name: a.name, domain: a.domain, companyId: company?.id ?? null, githubOrg: a.githubOrg ?? null })
    }),
    ro,
  ),

  tool(
    'update_company',
    'Record facts about a company: domain, email pattern (e.g. {first}.{last}), interest level (-1 avoid, 0, 1 interested, 2 dream — dream companies are polled every few minutes), funding, notes.',
    {
      name: z.string(),
      domain: z.string().optional(),
      website: z.string().optional(),
      description: z.string().optional(),
      interest: z.number().min(-1).max(2).optional(),
      emailPattern: z.string().optional(),
      fundingStage: z.string().optional(),
      fundingAmount: z.string().optional(),
      fundingAt: z.string().optional(),
      fundingNote: z.string().optional(),
      notes: z.string().optional(),
    },
    safe(({ name, ...rest }) => {
      const c = ensureCompany(name)
      const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
      db.update(schema.companies).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.companies.id, c.id)).run()
      if (rest.interest !== undefined) db.update(schema.sources).set({ tier: rest.interest >= 2 ? 'hot' : 'normal' }).where(eq(schema.sources.companyId, c.id)).run()
      return { id: c.id, name: c.name, ...patch }
    }),
  ),

  tool(
    'save_research',
    'Save a research brief (markdown with source links) to an application and/or company.',
    { applicationId: z.string().optional(), companyName: z.string().optional(), title: z.string(), bodyMd: z.string() },
    safe((a) => {
      const companyId = a.companyName ? ensureCompany(a.companyName).id : a.applicationId ? (getApplication(a.applicationId)?.companyId ?? null) : null
      const id = newId('res_')
      db.insert(schema.research).values({ id, applicationId: a.applicationId ?? null, companyId, title: a.title, bodyMd: a.bodyMd }).run()
      return { researchId: id }
    }),
  ),

  tool(
    'add_source',
    "Add a job board for the scout to poll. Give any careers/ATS URL (Greenhouse, Lever, Ashby, Workable, SmartRecruiters are auto-detected) or an RSS feed URL. A company's own careers page works too: Sidedoor looks for the ATS board it links to, then probes the usual ATSs under companyName.",
    { url: z.string(), name: z.string().optional(), companyName: z.string().optional(), hot: z.boolean().optional().describe('poll every few minutes') },
    safe(async (a) => {
      const isFeed = /rss|feed|\.xml/i.test(a.url)
      const det = detectAts(a.url) ?? (isFeed ? null : await boardBehind(a.url, a.companyName))
      const kind = det?.kind ?? (isFeed ? 'rss' : null)
      const guessed = !!det && 'guessed' in det && det.guessed
      if (!kind) {
        // A custom careers page: keep it on Sources as a candidate so it isn't lost, but the scout can't poll it.
        const company = a.companyName ? ensureCompany(a.companyName) : null
        db.insert(schema.sources)
          .values({ id: newId('src_'), name: a.name ?? a.companyName ?? a.url, kind: 'manual', board: a.url, url: a.url, companyId: company?.id ?? null, status: 'candidate', why: 'Custom careers page; not polled', origin: 'chat' })
          .onConflictDoNothing()
          .run()
        throw new Error("No ATS board or feed found on that page (checked its links and the usual ATSs under the company's name). Saved it on Sources as a candidate, but the scout can't poll custom careers pages; check it with read_page when needed.")
      }
      const board = det?.board ?? a.url
      const company = a.companyName ? ensureCompany(a.companyName, guessed ? {} : { atsKind: kind, atsBoard: board }) : null
      const status = guessed ? ('candidate' as const) : ('active' as const)
      const onConflict = { ...(guessed ? {} : { status: 'active' as const }), ...(a.hot ? { tier: 'hot' as const } : {}) }
      const insert = db.insert(schema.sources).values({ id: newId('src_'), name: a.name ?? a.companyName ?? board, kind, board, url: a.url, companyId: company?.id ?? null, status, tier: a.hot ? 'hot' : 'normal', origin: 'chat', ...(guessed ? { why: `Guessed from the name for ${a.url}` } : {}) })
      ;(Object.keys(onConflict).length ? insert.onConflictDoUpdate({ target: [schema.sources.kind, schema.sources.board], set: onConflict }) : insert.onConflictDoNothing()).run()
      const src = db.select().from(schema.sources).where(and(eq(schema.sources.kind, kind), eq(schema.sources.board, board))).get()!
      if (guessed)
        return {
          kind,
          board,
          sourceId: src.id,
          status: src.status,
          note: `The page links to no job board, so this ${kind} board was guessed from the name. It lists ${det && 'jobs' in det ? det.jobs : '?'} job(s). Compare it with the careers page (board_jobs vs read_page); if it's theirs and current, set_source_status active.`,
        }
      logActivity('scout', `Now watching ${a.name ?? a.companyName ?? board}`, { detail: `${kind}:${board}` })
      return { kind, board, sourceId: src.id, status: src.status }
    }),
  ),

  tool(
    'start_task',
    'Queue background AI work: research (company + people + emails for an application), prep (tailored resume + application package), outreach (draft messages to linked people), submit-assist (open the approved application form in Sidedoor\'s browser window on the user\'s desktop and fill it, stopping before submit; the user reviews and submits), discover (find new companies/boards), funding (scan funding news). Use instructions for specifics.',
    {
      kind: z.enum(['research', 'prep', 'outreach', 'discover', 'funding', 'custom', 'submit-assist']),
      applicationId: z.string().optional(),
      personId: z.string().optional(),
      instructions: z.string().optional(),
    },
    safe((a) => {
      const app = a.applicationId ? getApplication(a.applicationId) : undefined
      const label = app ? `${app.companyName} – ${app.role}` : (a.instructions?.slice(0, 60) ?? a.kind)
      const t = enqueueTask(a.kind, `${a.kind === 'submit-assist' ? 'Fill form' : `${a.kind[0]!.toUpperCase()}${a.kind.slice(1)}`}: ${label}`, {
        applicationId: a.applicationId ?? null,
        personId: a.personId ?? null,
        priority: 10,
        input: a.instructions ? { instructions: a.instructions } : {},
      })
      return { taskId: t.id, status: t.status }
    }),
  ),

  tool(
    'check_resume_match',
    "Re-run the resume match check for an application now and wait for it (about a minute, ~$0.10): checks its tailored resume (else the main one) against the posting and returns the 0-100 score and each requirement's level (strong/partial/weak/missing), the resume line ids that answer it, why, and a fix from the Experience document when one exists. The result replaces the one the user sees on the application and in the resume editor. Use it after editing a resume to see what moved; requirement ids stay the same across checks. get_application shows the last result without re-running.",
    { applicationId: z.string() },
    safe(async ({ applicationId }) => {
      const { matchForAgent, runMatch } = await import('../match')
      await runMatch(applicationId)
      const a = getApplication(applicationId)!
      logActivity('application', `Checked resume match: ${a.companyName} – ${a.role}`, { detail: `${a.matchJson?.score ?? '?'}/100`, link: `/applications/${a.id}` })
      return matchForAgent(a)
    }),
  ),

  tool(
    'run_scout_now',
    'Ask the worker to poll every active job source immediately instead of waiting for the schedule.',
    {},
    safe(() => {
      setMeta('scoutNow', nowIso())
      return 'The worker will start a full scan within a few seconds.'
    }),
  ),

  tool(
    'build_resume_pdf',
    'Render a resume to PDF with its theme and return the page count. Run it after editing a resume; the limit is in the prompt (usually 2 pages).',
    { resumeId: z.string() },
    safe(async ({ resumeId }) => {
      const r = await (await import('../services/resumes')).buildResumePdf(resumeId)
      return { pages: r.pages, file: r.file }
    }),
  ),

  tool(
    'check_tells',
    `Score a piece of writing for AI tells using the user's writing check rules (their writing style document explains them). Call it on every cover letter, application answer, resume summary and outreach message before saving it. Fix every hit with weight >= ${STRONG_WEIGHT} (strong tells), then re-check. Weak hits (lists of three, filler adverbs, And/But openers, single exclamation points) only matter in clusters.`,
    { text: z.string().describe('the exact text you are about to save') },
    safe(({ text }) => {
      if (!loadTellRules().length) return 'No writing check rules are set up. Apply the writing style document by hand.'
      const r = checkTells(text)
      const strong = strongHits(r)
      return {
        score: r.score,
        per100: r.per100,
        words: r.words,
        strongCount: strong.length,
        verdict: strong.length ? `Fix the ${strong.length} strong tell(s) (weight >= ${STRONG_WEIGHT}) before saving.` : 'No strong tells. Check weak ones only if they cluster.',
        hits: r.hits.map((h) => ({ line: h.line, label: h.label, weight: h.weight, match: h.match, fix: h.fix })),
      }
    }),
    ro,
  ),

  tool(
    'save_story',
    "Append one finished career story to the user's story bank as a '## <title>' section. Use their own words, edited only very slightly. Put any new number or fact they stated that isn't in their Experience document under factsToConfirm (never edit Experience from a story interview). Only call this after they confirmed the draft.",
    {
      title: z.string().describe('specific, e.g. "Cutting $300K from the cloud bill"'),
      role: z.string().describe('company and title, e.g. "Acme, Staff Engineer"'),
      date: z.string().describe('when it happened, e.g. "2024" or "spring 2025"'),
      who: z.string(),
      what: z.string(),
      where: z.string(),
      when: z.string(),
      why: z.string(),
      how: z.string(),
      decision: z.string().optional().describe('the call the user made and the alternatives'),
      numbers: z.array(z.string()).optional().describe('each number with what it measures'),
      readerContext: z.string().optional().describe('what a recruiter would not know (terms, products, stakes)'),
      readyToUse: z.string().describe('2-3 sentences, ready to paste into a cover letter or answer'),
      factsToConfirm: z.array(z.string()).optional().describe('new facts/numbers to confirm before they go in Experience'),
    },
    safe((a) => {
      const r = appendStory(a)
      logActivity('system', `Saved a story to the story bank: ${r.title}`, { link: '/stories' })
      return { saved: r.title }
    }),
  ),

  tool(
    'read_page',
    'Open a web page in a headless browser, let its JavaScript run, and return the text a person would see, plus any JSON-LD it embeds (job postings often carry jobLocationType and applicantLocationRequirements there). Use it instead of WebFetch for job postings and careers pages, and whenever WebFetch comes back empty or with only a title: Ashby, Workday, Lever, Rippling and most custom careers sites render with JavaScript. Read-only; it never clicks, types or signs in. Long pages come back in parts; pass nextOffset as offset to read on.',
    { url: z.string().url(), offset: z.number().int().min(0).optional() },
    safe(async (a) => (await import('../browser')).readPage(a.url, a.offset)),
    ro,
  ),

  tool(
    'update_person',
    "Edit a contact by id. Unlike upsert_person this can clear a field (pass null), rename them, move them to another company, or replace their notes. Changing companyName re-links the company. For a bounced email use mark_email_bounced instead, which also does the bookkeeping.",
    {
      id: z.string(),
      name: z.string().optional(),
      companyName: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      kind: kindEnum.optional(),
      stage: z.enum(schema.RELATIONSHIP_STAGES).optional(),
      priority: z.enum(['high', 'medium', 'low']).optional(),
      email: z.string().nullable().optional(),
      emailConfidence: z.enum(['verified', 'published', 'pattern', 'guessed']).nullable().optional(),
      emailSource: z.string().nullable().optional(),
      linkedin: z.string().nullable().optional(),
      x: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
      nextAction: z.string().nullable().optional(),
      nextContactAt: z.string().nullable().optional().describe('YYYY-MM-DD, or null for no follow-up'),
      cadenceDays: z.number().int().nullable().optional().describe('days between follow-ups'),
      whyMd: z.string().nullable().optional(),
      notes: z.string().nullable().optional().describe('replaces all notes; prefer appendNote'),
      appendNote: z.string().optional(),
    },
    safe(({ id, notes, appendNote, ...rest }) => {
      const cur = getPerson(id)
      if (!cur) throw new Error('not found')
      const patch: Parameters<typeof updatePerson>[1] = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
      if (rest.companyName === null) patch.companyId = null
      if (notes !== undefined) patch.notesMd = notes
      if (appendNote) {
        const base = notes !== undefined ? notes : cur.notesMd
        patch.notesMd = `${base ? `${base}\n` : ''}- **${today()}:** ${appendNote}`
      }
      return personBrief(updatePerson(id, patch)!)
    }),
  ),

  tool(
    'mark_email_bounced',
    "the user's email to someone bounced. Remembers the bad address so it's never suggested again, ranks its format last for the company if it was a guess, clears it, notes the bounce, undoes the follow-up the send scheduled, puts the bounced message back in drafts, and looks up the next most likely address (saved as the retry, with the resend draft pointed at it). A bounce can also mean they left the company.",
    { personId: z.string(), email: z.string().optional().describe('the address that bounced, if not the one on file') },
    safe(async (a) => {
      const b = markEmailBounced(a.personId, a.email ?? null)
      if (b.current) return { bounced: b.bounced, note: `That was an older address; ${b.current} is still on file.` }
      const r = await findEmailFor({ name: b.name, domain: b.domain, companyId: b.companyId, personId: b.personId }).catch(() => null)
      const next = r?.candidates[0] ?? null
      if (next) setRetryEmail({ personId: b.personId, email: next.email, confidence: next.confidence, source: `${next.source} (after ${b.bounced} bounced)`, draftId: b.resendDraftId })
      return { bounced: b.bounced, nextAddress: next, resendDraftId: b.resendDraftId }
    }),
  ),

  tool(
    'unlink_person',
    'Detach a contact from an application (they were linked by mistake or are not involved in this role). The contact itself stays.',
    { applicationId: z.string(), personId: z.string() },
    safe((a) => {
      unlinkPerson(a.applicationId, a.personId)
      return 'ok'
    }),
  ),

  tool(
    'delete_interaction',
    "Remove a touchpoint that was logged by mistake (ids are in get_person / get_application). If it was the person's latest contact, their last-contact date, follow-up and stage roll back. For a draft the user marked sent but didn't send, use reopen_draft instead.",
    { id: z.string() },
    safe(({ id }) => {
      deleteInteraction(id)
      return 'deleted'
    }),
  ),

  tool(
    'update_draft',
    "Edit an unsent outreach draft: body, subject, recipient address or person. Run check_tells on a new body first. Sent drafts are history and can't change.",
    { id: z.string(), body: z.string().optional(), subject: z.string().nullable().optional(), toEmail: z.string().nullable().optional(), personId: z.string().nullable().optional() },
    safe(({ id, ...rest }) => {
      updateDraft(id, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)))
      return db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()
    }),
  ),

  tool(
    'discard_draft',
    'Throw away an outreach draft the user no longer wants (a superseded copy, a wrong person).',
    { id: z.string() },
    safe(({ id }) => {
      discardDraft(id)
      return 'discarded'
    }),
  ),

  tool(
    'mark_draft_sent',
    'the user says they sent a draft himself (Gmail, LinkedIn, X). Marks it sent, logs the touchpoint and schedules the follow-up. Only when the user says they sent it; you never send anything.',
    { id: z.string(), nextContactInDays: z.number().int().optional() },
    safe((a) => {
      markDraftSent(a.id, a.nextContactInDays)
      return 'marked sent'
    }),
  ),

  tool(
    'reopen_draft',
    "Undo 'sent' (or 'discarded') on a draft: it goes back to being a draft they can send, and the Sent touchpoint and follow-up that marking it created are removed.",
    { id: z.string() },
    safe(({ id }) => {
      reopenDraft(id)
      return db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get()
    }),
  ),

  tool(
    'merge_applications',
    "Two applications are the same role (e.g. one from an aggregator, one from the company's board). Folds duplicateId into keepId: people, touchpoints, drafts, research, tasks and postings move over, missing fields fill in, notes are appended, and the duplicate is closed as 'Duplicate of <keepId>'. Keep the one with more work on it.",
    { keepId: z.string(), duplicateId: z.string() },
    safe((a) => appBrief(mergeApplications(a.keepId, a.duplicateId))),
  ),

  tool(
    'save_package',
    "Save an application's package: the review doc with the cover letter and form answers that the user reviews and the form filler pastes from. Replaces the whole package.",
    { applicationId: z.string(), packageMd: z.string() },
    safe((a) => {
      const app = getApplication(a.applicationId)
      if (!app) throw new Error('not found')
      updateApplication(app.id, { packageMd: a.packageMd })
      return { saved: true, chars: a.packageMd.length }
    }),
  ),

  tool(
    'board_jobs',
    "List open jobs straight from a company's own ATS board API (Ashby, Greenhouse, Lever, Workable, SmartRecruiters): title, location, job and apply links, posted date, pay. Give a board or job URL, or a company name (uses the board Sidedoor knows, else probes the usual ATSs by name, so check `board` is really theirs). Filter with `title` (all words must appear). includeJd adds each match's description. Use this to find a company's real listing for an aggregator repost, check remote/location, or see what else they have open, instead of paging api.ashbyhq.com or boards-api.greenhouse.io through WebFetch.",
    {
      url: z.string().optional(),
      company: z.string().optional(),
      title: z.string().optional(),
      includeJd: z.boolean().optional(),
      limit: z.number().int().max(100).optional(),
    },
    safe(async (a) => {
      let found: { kind: string; board: string; jobs: RawJob[] } | null = null
      const det = detectAts(a.url)
      if (det) found = { ...det, jobs: await Effect.runPromise(ADAPTERS[det.kind](det.board)) }
      else if (a.company) {
        // Look the company up without creating it: this tool is read-only.
        const slug = companySlug(a.company.trim())
        const known = db.select().from(schema.companies).where(eq(schema.companies.slug, slug)).get()
        found = await companyBoard(known ?? ({ id: '', name: a.company.trim(), slug, domain: null, atsKind: null, atsBoard: null } as schema.Company))
      }
      else throw new Error('Give a board/job URL or a company name')
      if (!found) throw new Error(`No Ashby/Greenhouse/Lever/Workable board found for ${a.company}. Try read_page on their careers page, then pass the board URL it links to.`)
      const words = a.title ? normTitle(a.title).split(' ').filter(Boolean) : []
      const jobs = found.jobs.filter((j) => words.every((w) => normTitle(j.title).split(' ').includes(w)))
      return {
        board: `${found.kind}:${found.board}`,
        total: found.jobs.length,
        matches: jobs.length,
        jobs: jobs.slice(0, a.limit ?? 40).map((j) => ({
          title: j.title,
          location: j.location,
          url: j.url,
          applyUrl: j.applyUrl,
          postedAt: j.postedAt,
          comp: j.comp,
          ...(a.includeJd ? { jd: truncate(j.jd, jobs.length > 3 ? 3000 : 12_000) } : {}),
        })),
      }
    }),
    ro,
  ),

  tool(
    'get_company',
    'One company: record (domain, email pattern and formats that bounced, interest, funding, ATS board, notes), the job sources watching it, every application there, and the contacts Sidedoor has at it.',
    { name: z.string().optional(), id: z.string().optional() },
    safe((a) => {
      const c = a.id
        ? db.select().from(schema.companies).where(eq(schema.companies.id, a.id)).get()
        : a.name
          ? db.select().from(schema.companies).where(or(eq(schema.companies.name, a.name), like(schema.companies.name, `${a.name}%`))).get()
          : undefined
      if (!c) throw new Error('not found')
      return {
        ...c,
        sources: db.select().from(schema.sources).where(eq(schema.sources.companyId, c.id)).all().map((x) => ({ id: x.id, kind: x.kind, board: x.board, status: x.status, tier: x.tier, lastCheckedAt: x.lastCheckedAt, lastError: x.lastError, lastJobCount: x.lastJobCount })),
        applications: db.select().from(schema.applications).where(or(eq(schema.applications.companyId, c.id), eq(schema.applications.companyName, c.name))).all().map((x) => ({ ...appBrief(x), closedReason: x.closedReason })),
        people: db.select().from(schema.people).where(eq(schema.people.companyId, c.id)).limit(40).all().map(personBrief),
      }
    }),
    ro,
  ),

  tool(
    'list_sources',
    "The job boards and feeds the scout polls, with their health (last check, last error, job count). Filter by status or text. Use it to spot a dead board (e.g. a company that moved ATS) or check whether a company is already watched.",
    { query: z.string().optional(), status: z.enum(['active', 'candidate', 'paused', 'rejected']).optional(), failingOnly: z.boolean().optional() },
    safe((a) => {
      const c = []
      if (a.status) c.push(eq(schema.sources.status, a.status))
      if (a.query) c.push(or(like(schema.sources.name, `%${a.query}%`), like(schema.sources.board, `%${a.query}%`))!)
      if (a.failingOnly) c.push(isNotNull(schema.sources.lastError))
      return db.select().from(schema.sources).where(and(...c)).limit(100).all().map((x) => ({ id: x.id, name: x.name, kind: x.kind, board: x.board, status: x.status, tier: x.tier, lastCheckedAt: x.lastCheckedAt, lastError: x.lastError, lastJobCount: x.lastJobCount }))
    }),
    ro,
  ),

  tool(
    'set_source_status',
    'Turn a job source on (active), off (paused), or reject it; or switch it between hot (polled every few minutes) and normal.',
    { id: z.string(), status: z.enum(['active', 'paused', 'rejected']).optional(), hot: z.boolean().optional() },
    safe((a) => {
      const patch = { ...(a.status ? { status: a.status } : {}), ...(a.hot !== undefined ? { tier: a.hot ? ('hot' as const) : ('normal' as const) } : {}) }
      if (Object.keys(patch).length) db.update(schema.sources).set(patch).where(eq(schema.sources.id, a.id)).run()
      return db.select().from(schema.sources).where(eq(schema.sources.id, a.id)).get() ?? 'not found'
    }),
  ),

  tool(
    'list_tasks',
    'Background AI tasks (prep, research, outreach, fill form, discover...), newest first. Filter by application or status.',
    { applicationId: z.string().optional(), status: z.enum(['queued', 'running', 'done', 'failed', 'cancelled']).optional(), limit: z.number().int().max(100).optional() },
    safe((a) => {
      const c = []
      if (a.applicationId) c.push(eq(schema.tasks.applicationId, a.applicationId))
      if (a.status) c.push(eq(schema.tasks.status, a.status))
      return db.select({ id: schema.tasks.id, kind: schema.tasks.kind, status: schema.tasks.status, title: schema.tasks.title, applicationId: schema.tasks.applicationId, createdAt: schema.tasks.createdAt, finishedAt: schema.tasks.finishedAt, error: schema.tasks.error }).from(schema.tasks).where(and(...c)).orderBy(desc(schema.tasks.createdAt)).limit(a.limit ?? 25).all()
    }),
    ro,
  ),

  tool(
    'get_task',
    "One background task: its instructions, result summary, error, and the tail of its transcript (what it tried and which tools it used). Use it to see why a task failed or what it actually did.",
    { id: z.string() },
    safe(({ id }) => {
      const t = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()
      if (!t) throw new Error('not found')
      return { ...t, output: truncate(t.output, 6000), log: t.log ? t.log.slice(-8000) : null }
    }),
    ro,
  ),

  tool(
    'cancel_task',
    "Cancel a queued background task (running ones can't be stopped from here).",
    { id: z.string() },
    safe(({ id }) => (cancelTask(id).changes ? 'cancelled' : 'Not cancelled: it is not queued (already running or finished).')),
  ),

  tool(
    'retry_task',
    'Re-queue a failed or cancelled background task as it was. To change what it does, start_task with instructions instead.',
    { id: z.string() },
    safe(({ id }) => {
      retryTask(id)
      return 'queued'
    }),
  ),

  tool(
    'report_gap',
    "Tell the user's developer about something you couldn't do because Sidedoor gave you no tool or access for it (a field you couldn't change, a site you couldn't read, a step you had to hand back to the user). Call it whenever that happens, then still tell the user plainly what you couldn't do. One call per gap.",
    {
      wanted: z.string().describe('what you were trying to do, e.g. "change an application\'s job URL"'),
      blocker: z.string().describe('what stopped you, e.g. "update_application has no jobUrl field"'),
      workaround: z.string().optional().describe('what you did instead, if anything'),
      suggestion: z.string().optional().describe('the tool or access that would have let you do it'),
    },
    safe((a) => {
      const line = `- **${nowIso().slice(0, 16).replace('T', ' ')}** ${a.wanted} | blocked by: ${a.blocker}${a.workaround ? ` | did instead: ${a.workaround}` : ''}${a.suggestion ? ` | wants: ${a.suggestion}` : ''}\n`
      appendFileSync(resolve(paths.logs, 'agent-gaps.md'), line)
      logActivity('system', `An agent couldn't ${truncate(a.wanted, 80)}`, { detail: a.blocker })
      return 'Recorded. Tell the user what you could not do.'
    }),
  ),

  tool(
    'notify_user',
    'Send the user a notification (desktop, and phone if they set it up). Use sparingly: only for things they should act on soon.',
    { title: z.string(), body: z.string(), path: z.string().optional().describe('app path to open, e.g. /applications/<id>'), urgent: z.boolean().optional() },
    safe(async (a) => notifyPromise({ kind: 'agent', title: a.title, body: a.body, ...(a.path ? { path: a.path } : {}), priority: a.urgent ? 4 : 3 })),
  ),
]

export const STAGES_HELP = Object.entries(STAGE_LABEL)
  .map(([k, v]) => `${k} (${v})`)
  .join(' → ')

/** Tool sets per MCP endpoint. Story interviews may only save stories; JSON jobs may only look things up. */
export const TOOL_PROFILES = {
  app: null,
  story: ['save_story', 'check_tells', 'get_profile_doc'],
  lookup: ['read_page', 'board_jobs', 'get_company', 'list_sources'],
} as const
export type ToolProfile = keyof typeof TOOL_PROFILES

export const toolsFor = (profile: ToolProfile) => {
  const only = TOOL_PROFILES[profile]
  const all = [...appTools, ...profileTools]
  return only ? all.filter((t) => (only as readonly string[]).includes(t.name)) : all
}

export const SERVER_INSTRUCTIONS = `Tools for Sidedoor, the user's job-search app. Pipeline stages: ${STAGES_HELP}. Facts about the user come only from their Experience document (get_profile_doc 'experience'), their resume, or what they tell you. Never send email or submit applications: draft them; the user acts.`
