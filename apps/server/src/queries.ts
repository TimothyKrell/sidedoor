import { and, desc, eq, gte, inArray, isNotNull, isNull, like, lte, ne, or, sql } from 'drizzle-orm'
import { db, schema } from './db/client'
import { today } from './ids'
import { linkedinUrl } from '@sidedoor/shared/linkedin'
import { xUrl } from '@sidedoor/shared/x'
import { resumeLines } from '@sidedoor/shared/resume'
import { isWritten } from './services/documents'
import { baseResume, getResume, resumeForApplication } from './services/resumes'
import { gmailComposeUrl } from './services/people'
import { prepInProgress } from './services/tasks'
import { getMeta, getSettings } from './settings'

const P = schema.postings
const A = schema.applications
const PE = schema.people

/** Columns for list views (no JD / package bodies). */
const postingCols = {
  id: P.id,
  companyId: P.companyId,
  companyName: P.companyName,
  title: P.title,
  location: P.location,
  url: P.url,
  applyUrl: P.applyUrl,
  postedAt: P.postedAt,
  firstSeenAt: P.firstSeenAt,
  closedAt: P.closedAt,
  compText: P.compText,
  compMin: P.compMin,
  compMax: P.compMax,
  decision: P.decision,
  fitScore: P.fitScore,
  lane: P.lane,
  summary: P.summary,
  locationFit: P.locationFit,
  locationNote: P.locationNote,
  userStatus: P.userStatus,
  applicationId: P.applicationId,
  sourceId: P.sourceId,
}

const appCols = {
  id: A.id,
  companyId: A.companyId,
  companyName: A.companyName,
  role: A.role,
  stage: A.stage,
  status: A.status,
  postingId: A.postingId,
  priority: A.priority,
  fitScore: A.fitScore,
  location: A.location,
  compText: A.compText,
  compMin: A.compMin,
  compMax: A.compMax,
  nextAction: A.nextAction,
  nextActionDate: A.nextActionDate,
  appliedAt: A.appliedAt,
  lastActivityAt: A.lastActivityAt,
  jobUrl: A.jobUrl,
  applyUrl: A.applyUrl,
  resumeId: A.resumeId,
  createdAt: A.createdAt,
}

export const workerStatus = () => {
  const lastScan = getMeta<{ at: string; sources: number; jobs: number; errors: number }>('lastScan')
  const tasks = db.select({ status: schema.tasks.status, n: sql<number>`count(*)` }).from(schema.tasks).where(inArray(schema.tasks.status, ['queued', 'running'])).groupBy(schema.tasks.status).all()
  const s = getSettings()
  return {
    lastScan: lastScan ?? null,
    // Jobs run inside the server process, so if this answers, they're running.
    workerAlive: true,
    running: tasks.find((t) => t.status === 'running')?.n ?? 0,
    queued: tasks.find((t) => t.status === 'queued')?.n ?? 0,
    paused: s.worker.paused,
    scoutEnabled: s.scout.enabled,
    ntfyTopic: s.notify.ntfyTopic,
    ntfyServer: s.notify.ntfyServer,
    pendingTriage: db.select({ n: sql<number>`count(*)` }).from(P).where(eq(P.triageStatus, 'pending')).get()?.n ?? 0,
  }
}

export const getToday = () => {
  const t = today()
  const s = getSettings()
  const since = new Date(Date.now() - 72 * 3600_000).toISOString()
  const fresh = db
    .select(postingCols)
    .from(P)
    .where(and(gte(P.firstSeenAt, since), gte(P.fitScore, s.triage.maybeFitScore), eq(P.userStatus, 'new'), isNull(P.closedAt), ne(P.decision, 'skip')))
    .orderBy(desc(P.fitScore))
    .limit(60)
    .all()
    // First-seen is recent, but skip roles that were actually posted long ago (e.g. a newly added board).
    .filter((p) => {
      const posted = p.postedAt ? new Date(p.postedAt).getTime() : Number.NaN
      return Number.isNaN(posted) || Date.now() - posted < 5 * 86400_000
    })
    .slice(0, 12)
  const review = db.select(appCols).from(A).where(and(inArray(A.stage, ['review', 'approved']), inArray(A.status, ['potential', 'active', 'on-hold']))).orderBy(desc(A.fitScore)).all()
  const prep = prepInProgress()
  const preparing = prep.size ? db.select(appCols).from(A).where(inArray(A.id, [...prep.keys()])).all().map((a) => ({ ...a, prep: prep.get(a.id)! })) : []
  const dueApps = db
    .select(appCols)
    .from(A)
    .where(and(isNotNull(A.nextActionDate), lte(A.nextActionDate, t), inArray(A.status, ['potential', 'active']), inArray(A.stage, ['applied', 'screening', 'interviewing', 'offer', 'interested'])))
    .orderBy(A.nextActionDate)
    .limit(30)
    .all()
  const duePeople = db.select().from(PE).where(and(isNotNull(PE.nextContactAt), lte(PE.nextContactAt, t))).orderBy(PE.nextContactAt).limit(30).all()
  const drafts = db
    .select({ draft: schema.drafts, personName: PE.name, personCompany: PE.companyName, personEmail: PE.email, personLinkedin: PE.linkedin, personX: PE.x, personEmailConfidence: PE.emailConfidence, personEmailSource: PE.emailSource })
    .from(schema.drafts)
    .leftJoin(PE, eq(PE.id, schema.drafts.personId))
    .where(eq(schema.drafts.status, 'draft'))
    .orderBy(desc(schema.drafts.createdAt))
    .limit(100)
    .all()
  const activity = db.select().from(schema.activity).orderBy(desc(schema.activity.at)).limit(40).all()
  const pipeline = db.select({ stage: A.stage, n: sql<number>`count(*)` }).from(A).where(inArray(A.status, ['potential', 'active', 'on-hold'])).groupBy(A.stage).all()
  const newToday = db.select({ n: sql<number>`count(*)` }).from(P).where(gte(P.firstSeenAt, new Date(Date.now() - 24 * 3600_000).toISOString())).get()?.n ?? 0
  // For the first-run checklist: is there anything to work with yet?
  const setup = {
    sources: db.select({ n: sql<number>`count(*)` }).from(schema.sources).where(eq(schema.sources.status, 'active')).get()?.n ?? 0,
    postings: db.select({ n: sql<number>`count(*)` }).from(P).get()?.n ?? 0,
    triaged: db.select({ n: sql<number>`count(*)` }).from(P).where(eq(P.triageStatus, 'done')).get()?.n ?? 0,
    applications: db.select({ n: sql<number>`count(*)` }).from(A).get()?.n ?? 0,
    experienceWritten: isWritten('experience'),
    aiConnected: !!getSettings().ai.default,
    resume: (() => {
      const r = baseResume()
      return r ? { id: r.id, lines: resumeLines(r.content).filter((l) => l.kind === 'bullet').length } : null
    })(),
  }
  return {
    setup,
    today: t,
    fresh,
    review,
    preparing,
    dueApps,
    duePeople,
    drafts: drafts.map((d) => ({ ...d, composeUrl: gmailComposeUrl(d.draft.toEmail ?? d.personEmail, d.draft.subject, d.draft.body), linkedinUrl: linkedinUrl({ name: d.personName, companyName: d.personCompany, linkedin: d.personLinkedin }), xUrl: xUrl(d.personX), emailNote: d.draft.channel === 'email' && d.draft.personId ? emailNote(d.draft.toEmail, { email: d.personEmail, emailConfidence: d.personEmailConfidence, emailSource: d.personEmailSource }) : null })),
    activity,
    pipeline: Object.fromEntries(pipeline.map((r) => [r.stage, r.n])) as Partial<Record<schema.ApplicationStage, number>>,
    newToday,
    status: workerStatus(),
  }
}

export interface PostingFilters {
  window?: '6h' | '24h' | '72h' | '7d' | '30d' | 'all'
  minFit?: number
  decision?: 'queue' | 'maybe' | 'skip' | 'triaged' | 'all'
  status?: 'new' | 'starred' | 'dismissed' | 'tracked' | 'all'
  q?: string
  limit?: number
}

const WINDOW_H: Record<NonNullable<PostingFilters['window']>, number> = { '6h': 6, '24h': 24, '72h': 72, '7d': 168, '30d': 720, all: 0 }

/** When the listing went up: the board's posted date, else when we first saw it. julianday() also evens out mixed time zones. */
const listedDay = sql<number>`coalesce(julianday(${P.postedAt}), julianday(${P.firstSeenAt}))`

export const listPostings = (f: PostingFilters) => {
  const c = [isNull(P.closedAt)]
  const h = WINDOW_H[f.window ?? '7d']
  if (h) c.push(sql`${listedDay} >= julianday('now') - ${h / 24}`)
  if (f.minFit) c.push(gte(P.fitScore, f.minFit))
  const d = f.decision ?? 'triaged'
  if (d === 'triaged') c.push(inArray(P.decision, ['queue', 'maybe']))
  else if (d !== 'all') c.push(eq(P.decision, d))
  const st = f.status ?? 'new'
  if (st !== 'all') c.push(eq(P.userStatus, st))
  if (f.q) c.push(or(like(P.companyName, `%${f.q}%`), like(P.title, `%${f.q}%`), like(P.location, `%${f.q}%`))!)
  return db
    .select(postingCols)
    .from(P)
    .where(and(...c))
    .orderBy(desc(listedDay))
    .limit(f.limit ?? 150)
    .all()
}

export const getPosting = (id: string) => {
  const p = db.select().from(P).where(eq(P.id, id)).get()
  if (!p) return null
  const company = p.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, p.companyId)).get() : null
  const source = p.sourceId ? db.select().from(schema.sources).where(eq(schema.sources.id, p.sourceId)).get() : null
  const siblings = p.companyId
    ? db.select(appCols).from(A).where(eq(A.companyId, p.companyId)).all()
    : []
  const people = p.companyId ? db.select().from(PE).where(eq(PE.companyId, p.companyId)).all() : []
  return { posting: p, company, source: source ? { name: source.name, kind: source.kind } : null, applicationsAtCompany: siblings, peopleAtCompany: people }
}

export const listApplications = () => {
  const open = db.select(appCols).from(A).where(ne(A.stage, 'closed')).orderBy(desc(A.lastActivityAt)).all()
  const closed = db.select(appCols).from(A).where(eq(A.stage, 'closed')).orderBy(desc(A.lastActivityAt)).limit(50).all()
  const counts = db
    .select({ applicationId: schema.applicationPeople.applicationId, n: sql<number>`count(*)` })
    .from(schema.applicationPeople)
    .groupBy(schema.applicationPeople.applicationId)
    .all()
  const peopleCount = Object.fromEntries(counts.map((c) => [c.applicationId, c.n]))
  // The posting behind each open application, for its listing age and salary. Older applications have no
  // posting id; match them by job URL, as getApplicationDetail does.
  const ids = open.flatMap((a) => (a.postingId ? [a.postingId] : []))
  const urls = open.flatMap((a) => (!a.postingId && a.jobUrl ? [a.jobUrl] : []))
  const postings = ids.length || urls.length
    ? db.select({ id: P.id, url: P.url, applyUrl: P.applyUrl, viaUrl: P.viaUrl, postedAt: P.postedAt, firstSeenAt: P.firstSeenAt, compText: P.compText, compMin: P.compMin, compMax: P.compMax })
        .from(P).where(or(inArray(P.id, ids), inArray(P.url, urls), inArray(P.applyUrl, urls), inArray(P.viaUrl, urls))).orderBy(desc(P.firstSeenAt)).all()
    : []
  const listingFor = (a: (typeof open)[number]) => {
    const p = a.postingId ? postings.find((x) => x.id === a.postingId) : a.jobUrl ? postings.find((x) => [x.url, x.applyUrl, x.viaUrl].includes(a.jobUrl)) : undefined
    return p ? { postedAt: p.postedAt, firstSeenAt: p.firstSeenAt, compText: p.compText, compMin: p.compMin, compMax: p.compMax } : null
  }
  const prep = prepInProgress()
  return { open: open.map((a) => ({ ...a, listing: listingFor(a), prep: prep.get(a.id) ?? null })), closed, peopleCount }
}

export const getApplicationDetail = (id: string) => {
  const a = db.select().from(A).where(eq(A.id, id)).get()
  if (!a) return null
  const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, id)).all()
  const people = links.length
    ? db.select().from(PE).where(inArray(PE.id, links.map((l) => l.personId))).all().map((p) => ({ ...p, role: links.find((l) => l.personId === p.id)?.role ?? null }))
    : []
  const drafts = db.select().from(schema.drafts).where(and(eq(schema.drafts.applicationId, id), ne(schema.drafts.status, 'discarded'))).orderBy(desc(schema.drafts.createdAt)).all()
  const research = db.select().from(schema.research).where(eq(schema.research.applicationId, id)).orderBy(desc(schema.research.createdAt)).all()
  const interactions = db.select().from(schema.interactions).where(eq(schema.interactions.applicationId, id)).orderBy(desc(schema.interactions.at)).all()
  const tasks = db.select().from(schema.tasks).where(eq(schema.tasks.applicationId, id)).orderBy(desc(schema.tasks.createdAt)).limit(20).all()
  // Older applications (imported, or added by hand) have no posting id; their job URL usually matches one.
  const posting = a.postingId
    ? db.select().from(P).where(eq(P.id, a.postingId)).get()
    : a.jobUrl
      ? db.select().from(P).where(or(eq(P.url, a.jobUrl), eq(P.applyUrl, a.jobUrl), eq(P.viaUrl, a.jobUrl))).orderBy(desc(P.firstSeenAt)).get()
      : null
  const company = a.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, a.companyId)).get() : null
  const others = a.companyId ? db.select(appCols).from(A).where(and(eq(A.companyId, a.companyId), ne(A.id, id))).all() : []
  const resume = a.resumeId ? getResume(a.resumeId) : undefined
  return {
    matchStale: matchStale(a),
    application: a,
    people,
    drafts: drafts.map((d) => {
      const p = people.find((x) => x.id === d.personId)
      return { ...d, personName: p?.name ?? null, composeUrl: gmailComposeUrl(d.toEmail ?? p?.email ?? null, d.subject, d.body), linkedinUrl: linkedinUrl(p), xUrl: xUrl(p?.x), emailNote: d.channel === 'email' ? emailNote(d.toEmail, p) : null }
    }),
    research,
    interactions,
    tasks,
    posting,
    company,
    otherApplications: others,
    resume: resume ? { id: resume.id, title: resume.title, pdfFile: resume.pdfFile, pdfPages: resume.pdfPages, updatedAt: resume.updatedAt } : null,
  }
}

export interface PeopleFilters {
  q?: string
  kind?: schema.PersonKind | 'all'
  view?: 'due' | 'all' | 'recruiters' | 'engaged' | 'not-contacted'
}

export const listPeople = (f: PeopleFilters) => {
  const c = []
  if (f.q) c.push(or(like(PE.name, `%${f.q}%`), like(PE.companyName, `%${f.q}%`), like(PE.title, `%${f.q}%`), like(PE.email, `%${f.q}%`))!)
  if (f.kind && f.kind !== 'all') c.push(eq(PE.kind, f.kind))
  if (f.view === 'due') c.push(and(isNotNull(PE.nextContactAt), lte(PE.nextContactAt, today()))!)
  if (f.view === 'recruiters') c.push(eq(PE.kind, 'recruiter'))
  if (f.view === 'engaged') c.push(inArray(PE.stage, ['replied', 'engaged']))
  if (f.view === 'not-contacted') c.push(eq(PE.stage, 'not-contacted'))
  const rows = db.select().from(PE).where(and(...c)).orderBy(sql`${PE.nextContactAt} is null`, PE.nextContactAt, desc(PE.updatedAt)).limit(300).all()
  const drafts = db.select({ personId: schema.drafts.personId, n: sql<number>`count(*)` }).from(schema.drafts).where(eq(schema.drafts.status, 'draft')).groupBy(schema.drafts.personId).all()
  return { people: rows, draftCount: Object.fromEntries(drafts.map((d) => [d.personId ?? '', d.n])) }
}

export const getPersonDetail = (id: string) => {
  const p = db.select().from(PE).where(eq(PE.id, id)).get()
  if (!p) return null
  const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.personId, id)).all()
  const applications = links.length ? db.select(appCols).from(A).where(inArray(A.id, links.map((l) => l.applicationId))).all() : []
  const interactions = db.select().from(schema.interactions).where(eq(schema.interactions.personId, id)).orderBy(desc(schema.interactions.at)).all()
  const drafts = db.select().from(schema.drafts).where(and(eq(schema.drafts.personId, id), ne(schema.drafts.status, 'discarded'))).orderBy(desc(schema.drafts.createdAt)).all()
  const company = p.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, p.companyId)).get() : null
  return {
    person: p,
    applications,
    interactions,
    drafts: drafts.map((d) => ({ ...d, composeUrl: gmailComposeUrl(d.toEmail ?? p.email, d.subject, d.body), linkedinUrl: linkedinUrl(p), xUrl: xUrl(p?.x), emailNote: d.channel === 'email' ? emailNote(d.toEmail, p) : null })),
    company,
  }
}

export const listRadar = () => {
  const funded = db.select().from(schema.companies).where(isNotNull(schema.companies.fundingAt)).orderBy(desc(schema.companies.fundingAt)).limit(120).all()
  const dream = db.select().from(schema.companies).where(gte(schema.companies.interest, 1)).orderBy(desc(schema.companies.interest), schema.companies.name).all()
  const watched = new Set(db.select({ c: schema.sources.companyId }).from(schema.sources).where(eq(schema.sources.status, 'active')).all().map((r) => r.c))
  const peopleCounts = Object.fromEntries(db.select({ c: PE.companyId, n: sql<number>`count(*)` }).from(PE).groupBy(PE.companyId).all().map((r) => [r.c ?? '', r.n]))
  const enrich = (c: schema.Company) => ({ ...c, watched: watched.has(c.id), people: peopleCounts[c.id] ?? 0 })
  return { funded: funded.map(enrich), dream: dream.map(enrich) }
}

export const listTasks = () => db.select().from(schema.tasks).orderBy(desc(schema.tasks.createdAt)).limit(150).all()

export const listSources = () => {
  const rows = db.select().from(schema.sources).orderBy(schema.sources.status, schema.sources.name).all()
  const open = Object.fromEntries(
    db.select({ s: P.sourceId, n: sql<number>`count(*)` }).from(P).where(and(isNull(P.closedAt), inArray(P.decision, ['queue', 'maybe']))).groupBy(P.sourceId).all().map((r) => [r.s ?? '', r.n]),
  )
  return rows.map((r) => ({ ...r, openMatches: open[r.id] ?? 0 }))
}

/** Why a draft's address might not arrive: it's a guess, or not the person's address on file. */
const emailNote = (to: string | null | undefined, p: { email: string | null; emailConfidence: string | null; emailSource: string | null } | null | undefined) => {
  const addr = (to ?? p?.email ?? '').toLowerCase()
  if (!addr || !p) return null
  if (p.email?.toLowerCase() !== addr) return { confidence: 'unknown', source: 'not the address on file for this person' }
  return p.emailConfidence === 'guessed' || p.emailConfidence === 'pattern' || !p.emailConfidence ? { confidence: p.emailConfidence ?? 'unknown', source: p.emailSource ?? '' } : null
}

/** The resume changed after the match check read it. */
const matchStale = (a: Pick<schema.Application, 'matchJson' | 'resumeId'>) => {
  if (!a.matchJson) return false
  const r = resumeForApplication(a)
  return !r || r.id !== a.matchJson.doc || String(r.version) !== a.matchJson.resumeVersion
}

/** The application a tailored resume belongs to, with its match, for the resume editor. */
export const getResumeMatch = (resumeId: string) => {
  const r = getResume(resumeId)
  if (!r?.applicationId) return null
  const a = db.select().from(A).where(eq(A.id, r.applicationId)).get()
  if (!a) return null
  const running = db.select({ id: schema.tasks.id }).from(schema.tasks).where(and(eq(schema.tasks.applicationId, a.id), eq(schema.tasks.kind, 'match'), inArray(schema.tasks.status, ['queued', 'running']))).get()
  return { applicationId: a.id, companyName: a.companyName, role: a.role, match: a.matchJson, stale: matchStale(a), running: !!running }
}

export const listThreads = () => db.select().from(schema.chatThreads).orderBy(desc(schema.chatThreads.updatedAt)).limit(60).all()

/** Threads for the chat panel's picker: ones the user used on this page first, then everything recent. */
export const panelThreads = (page: string | null) => {
  const T = schema.chatThreads
  const pick = { id: T.id, title: T.title, updatedAt: T.updatedAt }
  const notStory = sql`coalesce(json_extract(${T.context}, '$.mode'), '') != 'story'`
  const here = page
    ? db.select(pick).from(T)
        .where(and(notStory, or(sql`json_extract(${T.context}, '$.path') = ${page}`, inArray(T.id, db.select({ id: schema.chatMessages.threadId }).from(schema.chatMessages).where(eq(schema.chatMessages.page, page))))))
        .orderBy(desc(T.updatedAt)).limit(10).all()
    : []
  const seen = new Set(here.map((t) => t.id))
  const recent = db.select(pick).from(T).where(notStory).orderBy(desc(T.updatedAt)).limit(25).all().filter((t) => !seen.has(t.id)).slice(0, 15)
  return { here, recent }
}

export const getThread = (id: string) => {
  const thread = db.select().from(schema.chatThreads).where(eq(schema.chatThreads.id, id)).get()
  if (!thread) return null
  const messages = db.select().from(schema.chatMessages).where(eq(schema.chatMessages.threadId, id)).orderBy(schema.chatMessages.at).all()
  return { thread, messages }
}

export const searchAll = (q: string) => {
  const like_ = `%${q}%`
  return {
    applications: db.select(appCols).from(A).where(or(like(A.companyName, like_), like(A.role, like_))).orderBy(sql`${A.status} like 'closed%'`, desc(sql`coalesce(${A.lastActivityAt}, ${A.createdAt})`)).limit(8).all(),
    people: db.select({ id: PE.id, name: PE.name, companyName: PE.companyName, title: PE.title }).from(PE).where(or(like(PE.name, like_), like(PE.companyName, like_))).limit(8).all(),
    postings: db.select(postingCols).from(P).where(and(isNull(P.closedAt), inArray(P.decision, ['queue', 'maybe']), or(like(P.companyName, like_), like(P.title, like_)))).orderBy(desc(P.firstSeenAt)).limit(8).all(),
  }
}
