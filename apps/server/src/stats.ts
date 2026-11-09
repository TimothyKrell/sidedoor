import { sql } from 'drizzle-orm'
import { localDay } from '@sidedoor/shared/format'
import { db, schema } from './db/client'

export const STATS_WINDOWS = ['24h', '7d', '30d', 'all'] as const
export type StatsWindow = (typeof STATS_WINDOWS)[number]

/** How long a submitted application can sit with no answer before it counts as gone quiet. */
const QUIET_DAYS = 14
const DAY = 86_400_000

type Row = { label: string; n: number }
const ORDER: Partial<Record<schema.ApplicationStage, number>> = { interested: 0, review: 1, approved: 2, applied: 3, screening: 4, interviewing: 5, offer: 6 }
const LIVE_SENT: schema.ApplicationStage[] = ['applied', 'screening', 'interviewing', 'offer']

/** Dates come as timestamps with any offset or as a bare day. A bare day has no time, so it sits at local noon. */
const when = (s: string | null | undefined) => {
  if (!s) return null
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s)
  return Number.isNaN(d.getTime()) ? null : d
}
const days = (from: Date, to: Date) => (to.getTime() - from.getTime()) / DAY
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const plusDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours())
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1
  return s.length === 0 ? null : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}
const daysText = (d: number) => (d < 1 ? 'Same day' : `${Math.round(d)} day${Math.round(d) === 1 ? '' : 's'}`)
const round1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10)
const tally = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1)
  return [...m].map(([label, n]): Row => ({ label, n })).sort((a, b) => b.n - a.n)
}

export type CloseKind = 'rejected' | 'listing' | 'remote' | 'location' | 'pay' | 'passed' | 'duplicate' | 'other'
const CLOSE_LABEL: Record<CloseKind, string> = {
  rejected: 'Rejected by the company',
  listing: 'Listing closed',
  remote: 'Not remote',
  location: 'Wrong location',
  pay: 'Pay too low',
  passed: 'You passed',
  duplicate: 'Duplicate',
  other: 'No reason given',
}

/**
 * Why an application closed. Reasons are free text, written by the user's buttons and by agents, and
 * agents often closed one with no reason and put the rejection in the notes, so a blank reason falls
 * back to the latest note. "Rejected" has to be what happened to this application: a cooldown after
 * another application's rejection isn't one.
 */
export const closeKind = (reason: string | null | undefined, notes?: string | null): CloseKind => {
  const r = reason?.trim()
  if (!r) return /\breject/i.test(notes?.trim().split('\n').at(-1) ?? '') ? 'rejected' : 'other'
  if (/^rejected\b|\brejected by\b|^rejection\b/i.test(r)) return 'rejected'
  if (/duplicate|replaced by|^cleared/i.test(r)) return 'duplicate'
  if (/listing (closed|stale)|posting removed|no longer|stale posting|^closed\b/i.test(r)) return 'listing'
  if (/hybrid|not remote|in[- ]office|on[- ]?site|commute/i.test(r)) return 'remote'
  if (/-only|ineligible|not eligible|location|reside/i.test(r)) return 'location'
  if (/^pay\b|salary|under the \$|below target/i.test(r)) return 'pay'
  return 'passed'
}

/**
 * The stages an application really reached. A move put right within the hour (a drag to the wrong
 * column, a click through the stages) never happened; moving on, or to Closed, keeps it.
 */
export const reachedStages = (changes: Array<{ stage: schema.ApplicationStage; at: string }>, current: schema.ApplicationStage) => {
  const reached = new Map<schema.ApplicationStage, Date>()
  changes.forEach((c, i) => {
    const at = when(c.at)
    const next = changes[i + 1]
    const nextAt = when(next?.at)
    if (!at) return
    const undone = next && nextAt && days(at, nextAt) * 24 < 1 && (ORDER[next.stage] ?? 99) < (ORDER[c.stage] ?? -1)
    if (!undone && !reached.has(c.stage)) reached.set(c.stage, at)
  })
  return { reached, top: Math.max(ORDER[current] ?? -1, ...[...reached.keys()].map((s) => ORDER[s] ?? -1)) }
}

const ats = (url: string | null) => {
  const known: Array<[RegExp, string]> = [[/ashbyhq/, 'Ashby'], [/greenhouse/, 'Greenhouse'], [/lever\.co/, 'Lever'], [/workable/, 'Workable'], [/myworkday/, 'Workday'], [/rippling/, 'Rippling'], [/smartrecruiters/, 'SmartRecruiters'], [/linkedin/, 'LinkedIn']]
  return known.find(([re]) => url && re.test(url))?.[1] ?? 'Other'
}
const fitBand = (fit: number | null) => (fit == null ? 'No score' : fit >= 85 ? '85 and up' : fit >= 70 ? '70–84' : fit >= 55 ? '55–69' : 'Under 55')
const payBand = (max: number | null, min: number | null) => {
  const top = max ?? min
  if (top == null) return 'Not listed'
  return top >= 300_000 ? '$300K and up' : top >= 250_000 ? '$250–299K' : top >= 200_000 ? '$200–249K' : top >= 150_000 ? '$150–199K' : 'Under $150K'
}
const levelBand = (role: string) => (/\b(manager|director|head of|vp|vice president|chief|cto|tlm)\b/i.test(role) ? 'Leadership titles' : 'Other titles')

/** The period asked for, the one before it to compare with, and how its chart is cut up. */
const period = (window: StatsWindow, now: Date, first: Date) => {
  if (window === '24h') {
    const since = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() - 23)
    return { since, prev: new Date(since.getTime() - DAY), unit: 'hour' as const }
  }
  if (window === 'all') {
    const since = startOfDay(first)
    return { since, prev: null, unit: days(since, now) > 92 ? ('week' as const) : ('day' as const) }
  }
  const n = window === '7d' ? 7 : 30
  const since = plusDays(startOfDay(now), 1 - n)
  return { since, prev: plusDays(since, -n), unit: 'day' as const }
}

const monday = (d: Date) => plusDays(startOfDay(d), -((d.getDay() + 6) % 7))
const bucketOf = (d: Date, unit: 'hour' | 'day' | 'week') => (unit === 'hour' ? `${localDay(d)}T${String(d.getHours()).padStart(2, '0')}` : localDay(unit === 'week' ? monday(d) : d))

/** Longest run of consecutive days, and the run still going (today, or yesterday if today has none yet). */
const streaks = (dayKeys: Set<string>, now: Date) => {
  let longest = 0
  for (const k of dayKeys) {
    if (dayKeys.has(localDay(plusDays(when(k)!, -1)))) continue
    let n = 1
    while (dayKeys.has(localDay(plusDays(when(k)!, n)))) n++
    longest = Math.max(longest, n)
  }
  let d = dayKeys.has(localDay(now)) ? now : plusDays(now, -1)
  let current = 0
  while (dayKeys.has(localDay(d))) {
    current++
    d = plusDays(d, -1)
  }
  return { current, longest }
}

const TASK_LABEL: Record<string, string> = {
  prep: 'Application packages',
  tune: 'Resume tuning',
  research: 'Company research',
  custom: 'Things you asked for',
  'submit-assist': 'Filling forms',
  outreach: 'Outreach drafts',
  triage: 'Reading postings',
  match: 'Resume checks',
  'stale-check': 'Stale draft checks',
  discover: 'Finding sources',
  funding: 'Funding news',
  brief: 'Job summaries',
}

/** Everything on the Stats page for one period, from the same tables the rest of the app reads. */
export const getStats = (window: StatsWindow = 'all', now = new Date()) => {
  const A = schema.applications
  const P = schema.postings
  const apps = db
    .select({ id: A.id, companyName: A.companyName, role: A.role, stage: A.stage, status: A.status, fitScore: A.fitScore, compMin: A.compMin, compMax: A.compMax, appliedAt: A.appliedAt, postedAt: A.postedAt, createdAt: A.createdAt, updatedAt: A.updatedAt, closedReason: A.closedReason, notesMd: A.notesMd, jobUrl: A.jobUrl, applyUrl: A.applyUrl })
    .from(A)
    .all()
  const changes = new Map<string, schema.StageChange[]>()
  for (const c of db.select().from(schema.stageChanges).orderBy(schema.stageChanges.at).all()) changes.set(c.applicationId, [...(changes.get(c.applicationId) ?? []), c])
  // A call or meeting logged on an application is an interview, whatever stage it was left in: agents
  // often log the screen and close the application without ever moving it to Screening.
  const met = new Map<string, Date>()
  const I = schema.interactions
  for (const x of db.select({ applicationId: I.applicationId, at: I.at, summary: I.summary }).from(I).where(sql`${I.channel} in ('call', 'meeting') and ${I.direction} != 'out' and ${I.applicationId} is not null`).all()) {
    const at = when(x.at)
    if (!at || at > now || /\b(booked|scheduled)\b/i.test(x.summary)) continue
    const seen = met.get(x.applicationId!)
    if (!seen || at < seen) met.set(x.applicationId!, at)
  }

  // Each application's story: when it went in, how far it got, how it ended.
  const story = apps.map((a) => {
    const history = changes.get(a.id) ?? []
    const { reached, top } = reachedStages(history, a.stage)
    const closed = a.stage === 'closed'
    const kind = closed ? closeKind(a.closedReason, a.notesMd) : null
    const won = a.status === 'closed-won'
    const metAt = met.get(a.id) ?? null
    const earliest = (...ds: Array<Date | null | undefined>) => ds.filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0] ?? null
    const staged = reached.get('screening') ?? reached.get('interviewing') ?? reached.get('offer') ?? (top >= ORDER.screening! ? (when(a.createdAt) ?? null) : null)
    const talkedAt = earliest(staged, metAt)
    const interviewedAt = earliest(reached.get('interviewing') ?? reached.get('offer') ?? (top >= ORDER.interviewing! ? (when(a.createdAt) ?? null) : null), metAt)
    const sent = LIVE_SENT.includes(a.stage) || (closed && kind !== 'duplicate' && (!!a.appliedAt || kind === 'rejected' || won || !!talkedAt))
    const sentAt = earliest(when(a.appliedAt) ?? reached.get('applied') ?? reached.get('screening') ?? reached.get('interviewing') ?? when(a.createdAt)!, talkedAt)!
    const closedAt = closed ? (when(history.filter((c) => c.stage === 'closed').at(-1)?.at) ?? when(a.updatedAt)!) : null
    const quiet = a.stage === 'applied' && !talkedAt && days(sentAt, now) >= QUIET_DAYS
    const outcome = won || top >= ORDER.offer! ? 'offer' : !closed && talkedAt ? 'talking' : kind === 'rejected' ? 'rejected' : closed ? 'withdrew' : quiet ? 'quiet' : 'waiting'
    return { ...a, kind, won, sent, sentAt, closedAt, talkedAt, interviewedAt, top, outcome }
  })
  const sent = story.filter((a) => a.sent)

  const firstSeen = db.select({ at: sql<string | null>`min(${P.firstSeenAt})` }).from(P).get()?.at
  const firstDates = [...sent.map((a) => a.sentAt), when(firstSeen)].filter((d): d is Date => !!d)
  const first = firstDates.length ? new Date(Math.min(...firstDates.map((d) => d.getTime()))) : now
  const { since, prev, unit } = period(window, now, first)
  const inWindow = (d: Date | null | undefined) => !!d && d >= since && d <= now
  const inPrev = (d: Date | null | undefined) => !!d && !!prev && d >= prev && d < since
  const compare = <T>(xs: T[], at: (x: T) => Date | null | undefined) => ({ now: xs.filter((x) => inWindow(at(x))).length, prev: prev ? xs.filter((x) => inPrev(at(x))).length : null })

  const rejected = story.filter((a) => a.kind === 'rejected')
  const talked = story.filter((a) => a.talkedAt)
  const cohort = sent.filter((a) => inWindow(a.sentAt))
  const heard = (a: (typeof story)[number]) => a.kind === 'rejected' || !!a.talkedAt
  const prevCohort = sent.filter((a) => inPrev(a.sentAt))
  const rate = (xs: typeof story) => (xs.length ? xs.filter(heard).length / xs.length : null)

  // Scout: postings are too many to load, so count them in the database, a local day (or hour) at a time.
  const cut = unit === 'hour' ? '%Y-%m-%dT%H' : '%Y-%m-%d'
  const from = (prev ?? since).toISOString()
  const scoutRows = db
    .select({
      bucket: sql<string>`strftime(${cut}, ${P.firstSeenAt}, 'localtime')`,
      seen: sql<number>`count(*)`,
      read: sql<number>`sum(${P.triageStatus} = 'done')`,
      good: sql<number>`sum(${P.decision} in ('queue', 'maybe'))`,
      tracked: sql<number>`sum(${P.applicationId} is not null)`,
    })
    .from(P)
    .where(sql`julianday(${P.firstSeenAt}) >= julianday(${from})`)
    .groupBy(sql`1`)
    .all()
  const bucketStart = (b: string) => new Date(b.length > 10 ? `${b}:00:00` : `${b}T00:00:00`)
  const scoutIn = scoutRows.filter((r) => inWindow(bucketStart(r.bucket)))
  const sum = (k: 'seen' | 'read' | 'good' | 'tracked') => scoutIn.reduce((n, r) => n + (r[k] ?? 0), 0)
  const seenPrev = prev ? scoutRows.filter((r) => !scoutIn.includes(r)).reduce((n, r) => n + r.seen, 0) : null
  const sinceIso = since.toISOString()
  const inScoutWindow = sql`julianday(${P.firstSeenAt}) >= julianday(${sinceIso})`
  const fit = db
    .select({ band: sql<number>`(${P.fitScore} / 10) * 10`, n: sql<number>`count(*)` })
    .from(P)
    .where(sql`${P.fitScore} is not null and ${inScoutWindow}`)
    .groupBy(sql`1`)
    .all()
  const goodSources = db
    .select({ label: schema.sources.name, n: sql<number>`count(*)` })
    .from(P)
    .innerJoin(schema.sources, sql`${schema.sources.id} = ${P.sourceId}`)
    .where(sql`${P.decision} in ('queue', 'maybe') and ${inScoutWindow}`)
    .groupBy(schema.sources.name)
    .orderBy(sql`2 desc`)
    .limit(6)
    .all()
  const sources = db.select({ status: schema.sources.status, n: sql<number>`count(*)` }).from(schema.sources).groupBy(schema.sources.status).all()

  // The timeline: every bucket in the period, empty ones included.
  const series = new Map<string, { at: string; submitted: number; rejected: number; seen: number }>()
  for (let d = unit === 'week' ? monday(since) : since; d <= now; d = unit === 'hour' ? new Date(d.getTime() + 3600_000) : plusDays(d, unit === 'week' ? 7 : 1)) {
    const at = bucketOf(d, unit)
    series.set(at, { at, submitted: 0, rejected: 0, seen: 0 })
  }
  const add = (d: Date, k: 'submitted' | 'rejected' | 'seen', n = 1) => {
    const b = series.get(bucketOf(d, unit))
    if (b) b[k] += n
  }
  for (const a of cohort) add(a.sentAt, 'submitted')
  for (const a of rejected) if (inWindow(a.closedAt)) add(a.closedAt!, 'rejected')
  for (const r of scoutIn) add(bucketStart(r.bucket), 'seen', r.seen)

  // Calendar and records always cover the whole search.
  const perDay = new Map<string, { submitted: number; rejected: number }>()
  const day = (k: string) => perDay.get(k) ?? perDay.set(k, { submitted: 0, rejected: 0 }).get(k)!
  for (const a of sent) day(localDay(a.sentAt)).submitted++
  for (const a of rejected) if (a.closedAt) day(localDay(a.closedAt)).rejected++
  const submittedDays = new Set([...perDay].filter(([, v]) => v.submitted > 0).map(([k]) => k))
  const biggest = [...perDay].sort((a, b) => b[1].submitted - a[1].submitted)[0]
  const appLabel = (a: { companyName: string; role: string }) => `${a.companyName} – ${a.role}`
  const answered = rejected.filter((a) => a.sent && a.closedAt).map((a) => ({ a, d: days(a.sentAt, a.closedAt!) })).filter((x) => x.d >= 0)
  const fastest = [...answered].sort((a, b) => a.d - b.d)[0]
  const slowest = [...answered].sort((a, b) => b.d - a.d)[0]
  const oldest = sent.filter((a) => a.stage === 'applied').sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime())[0]
  const bestFitNo = rejected.filter((a) => a.fitScore != null).sort((a, b) => b.fitScore! - a.fitScore!)[0]
  const topPay = sent.filter((a) => a.compMax != null).sort((a, b) => b.compMax! - a.compMax!)[0]
  const topCompany = tally(sent, (a) => a.companyName)[0]

  // How each kind of application fared, side by side.
  const fared = (key: (a: (typeof sent)[number]) => string, order?: string[]) => {
    const groups = new Map<string, typeof sent>()
    for (const a of cohort) groups.set(key(a), [...(groups.get(key(a)) ?? []), a])
    const rows = [...groups].map(([label, xs]) => ({
      label,
      sent: xs.length,
      talked: xs.filter((a) => a.talkedAt).length,
      rejected: xs.filter((a) => a.outcome === 'rejected').length,
    }))
    return rows.sort((a, b) => (order ? order.indexOf(a.label) - order.indexOf(b.label) : b.sent - a.sent))
  }

  // People and outreach.
  const people = db.select({ stage: schema.people.stage, createdAt: schema.people.createdAt }).from(schema.people).all()
  const touches = db.select({ channel: schema.interactions.channel, direction: schema.interactions.direction, at: schema.interactions.at }).from(schema.interactions).all().filter((x) => x.direction !== 'note' && inWindow(when(x.at)))
  const drafts = db.select({ status: schema.drafts.status, createdAt: schema.drafts.createdAt, sentAt: schema.drafts.sentAt }).from(schema.drafts).all()
  const contacted = people.filter((p) => p.stage !== 'not-contacted')
  const replied = people.filter((p) => p.stage === 'replied' || p.stage === 'engaged')
  const channels = [...new Set(touches.map((t) => t.channel))]

  // AI work. Cost is what the provider reports: API-equivalent, usually on a subscription.
  const tasks = db.select({ kind: schema.tasks.kind, status: schema.tasks.status, costUsd: schema.tasks.costUsd, startedAt: schema.tasks.startedAt, finishedAt: schema.tasks.finishedAt }).from(schema.tasks).all().filter((t) => inWindow(when(t.finishedAt)))
  const cost = tasks.reduce((n, t) => n + (t.costUsd ?? 0), 0)
  const hours = tasks.reduce((n, t) => {
    const a = when(t.startedAt)
    const b = when(t.finishedAt)
    return a && b ? n + Math.max(0, days(a, b) * 24) : n
  }, 0)
  const costByKind = new Map<string, number>()
  for (const t of tasks) costByKind.set(t.kind, (costByKind.get(t.kind) ?? 0) + (t.costUsd ?? 0))
  const resumes = db.select({ kind: schema.resumes.kind, createdAt: schema.resumes.createdAt }).from(schema.resumes).all().filter((r) => r.kind === 'tailored' && inWindow(when(r.createdAt)))
  const questions = db.select({ answeredAt: schema.questions.answeredAt, answeredBy: schema.questions.answeredBy }).from(schema.questions).all().filter((q) => q.answeredBy !== 'package' && inWindow(when(q.answeredAt)))

  const closedIn = story.filter((a) => a.kind && inWindow(a.closedAt))
  const waiting = sent.filter((a) => a.stage === 'applied')
  return {
    window,
    since: since.toISOString(),
    unit,
    hasData: story.length > 0 || scoutRows.length > 0,
    tiles: {
      submitted: compare(sent, (a) => a.sentAt),
      rejected: compare(rejected, (a) => a.closedAt),
      talked: compare(talked, (a) => a.talkedAt),
      responseRate: { now: rate(cohort), prev: prev ? rate(prevCohort) : null },
      waiting: waiting.length,
      quiet: waiting.filter((a) => a.outcome === 'quiet').length,
      seen: { now: sum('seen'), prev: seenPrev },
    },
    /** Submitted with no date of ours: sent by another service, or a recruiter brought the role. */
    noForm: cohort.filter((a) => !a.appliedAt).length,
    series: [...series.values()],
    funnel: {
      submitted: cohort.length,
      heard: cohort.filter(heard).length,
      talked: cohort.filter((a) => a.talkedAt).length,
      interviewed: cohort.filter((a) => a.interviewedAt).length,
      offers: cohort.filter((a) => a.outcome === 'offer').length,
    },
    outcomes: { offer: 0, talking: 0, waiting: 0, quiet: 0, rejected: 0, withdrew: 0, ...Object.fromEntries(tally(cohort, (a) => a.outcome).map((r) => [r.label, r.n])) } as Record<'offer' | 'talking' | 'waiting' | 'quiet' | 'rejected' | 'withdrew', number>,
    quietDays: QUIET_DAYS,
    closed: tally(closedIn, (a) => a.kind!).map((r) => ({ kind: r.label as CloseKind, label: CLOSE_LABEL[r.label as CloseKind], n: r.n })),
    speed: {
      toRejection: round1(median(rejected.filter((a) => a.sent && inWindow(a.closedAt)).map((a) => days(a.sentAt, a.closedAt!)).filter((d) => d >= 0))),
      toSubmit: round1(median(cohort.map((a) => days(when(a.createdAt)!, a.sentAt)).filter((d) => d >= 0))),
      listingAge: round1(median(cohort.flatMap((a) => (when(a.postedAt) ? [days(when(a.postedAt)!, a.sentAt)] : [])).filter((d) => d >= 0))),
    },
    fared: {
      fit: fared((a) => fitBand(a.fitScore), ['85 and up', '70–84', '55–69', 'Under 55', 'No score']),
      pay: fared((a) => payBand(a.compMax, a.compMin), ['$300K and up', '$250–299K', '$200–249K', '$150–199K', 'Under $150K', 'Not listed']),
      level: fared((a) => levelBand(a.role)),
      ats: fared((a) => ats(a.applyUrl ?? a.jobUrl)),
    },
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, i) => ({ label, n: cohort.filter((a) => (a.sentAt.getDay() + 6) % 7 === i).length })),
    scout: {
      seen: sum('seen'),
      read: sum('read'),
      good: sum('good'),
      tracked: sum('tracked'),
      fit: [...fit].sort((a, b) => a.band - b.band),
      sources: goodSources,
      active: sources.find((s) => s.status === 'active')?.n ?? 0,
    },
    pipeline: tally(story.filter((a) => a.stage !== 'closed'), (a) => a.stage),
    people: {
      added: people.filter((p) => inWindow(when(p.createdAt))).length,
      known: people.length,
      contacted: contacted.length,
      replied: replied.length,
      out: touches.filter((t) => t.direction === 'out').length,
      in: touches.filter((t) => t.direction === 'in').length,
      draftsWritten: drafts.filter((d) => inWindow(when(d.createdAt))).length,
      draftsSent: drafts.filter((d) => inWindow(when(d.sentAt))).length,
      draftsWaiting: drafts.filter((d) => d.status === 'draft').length,
      channels: channels.map((c) => ({ label: c, out: touches.filter((t) => t.channel === c && t.direction === 'out').length, in: touches.filter((t) => t.channel === c && t.direction === 'in').length })).sort((a, b) => b.out + b.in - a.out - a.in),
    },
    ai: {
      done: tasks.filter((t) => t.status === 'done').length,
      failed: tasks.filter((t) => t.status === 'failed').length,
      hours: round1(hours),
      cost: Math.round(cost * 100) / 100,
      perApplication: cohort.length ? Math.round((cost / cohort.length) * 100) / 100 : null,
      resumes: resumes.length,
      questions: questions.length,
      byKind: [...costByKind].map(([kind, usd]) => ({ label: TASK_LABEL[kind] ?? kind, usd: Math.round(usd * 100) / 100 })).filter((r) => r.usd > 0).sort((a, b) => b.usd - a.usd).slice(0, 7),
    },
    calendar: [...perDay].map(([date, v]) => ({ date, ...v })),
    streak: streaks(submittedDays, now),
    activeDays: submittedDays.size,
    records: [
      biggest && biggest[1].submitted > 0 ? { label: 'Biggest day', value: `${biggest[1].submitted} sent`, detail: biggest[0], link: null } : null,
      fastest ? { label: 'Fastest no', value: daysText(fastest.d), detail: appLabel(fastest.a), link: fastest.a.id } : null,
      slowest ? { label: 'Slowest no', value: daysText(slowest.d), detail: appLabel(slowest.a), link: slowest.a.id } : null,
      oldest ? { label: 'Waiting longest', value: daysText(days(oldest.sentAt, now)), detail: appLabel(oldest), link: oldest.id } : null,
      bestFitNo ? { label: 'Best fit that said no', value: `Fit ${bestFitNo.fitScore}`, detail: appLabel(bestFitNo), link: bestFitNo.id } : null,
      topPay ? { label: 'Highest pay you went for', value: `$${Math.round(topPay.compMax! / 1000)}K`, detail: appLabel(topPay), link: topPay.id } : null,
      topCompany && topCompany.n > 1 ? { label: 'Most applications to one company', value: String(topCompany.n), detail: topCompany.label, link: null } : null,
    ].filter((r) => r !== null),
  }
}
