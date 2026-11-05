import { and, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { AGGREGATOR_KINDS } from '../scout/adapters'
import { type BoardCache, checkHost, checkListing, type Fetcher, type ListingCheck, parseJobUrl } from '../scout/listing'
import { getApplication } from '../services/applications'
import { recordListingCheck, recordPostedAt } from '../services/listings'

/**
 * Checking listings: whether each open application's job is still up, and when it was posted.
 * The scheduler checks a few at a time (jobs/runner.ts); `check_listing` and the app's "Check
 * listing" do one, or every open application at once (the backfill), on demand.
 */

/** Stages worth watching on the schedule: not sent yet, so a closed listing changes what you do. */
export const WATCHED: schema.ApplicationStage[] = ['interested', 'review', 'approved']
/** A listing checked within this long isn't checked again on the schedule. One miss gets a quicker second look. */
export const RECHECK_HOURS = 24
export const SUSPECT_RECHECK_HOURS = 4
/** Least time between two calls to one ATS host. */
export const HOST_GAP_MS = 1500

const A = schema.applications

/** The link to ask about: the first one an ATS API can answer for, else the job page. */
const urlFor = (a: schema.Application, posting: schema.Posting | undefined, hint: { kind?: string | null; board?: string | null }) => {
  const links = [a.jobUrl, a.applyUrl, posting?.url, posting?.applyUrl].filter((u): u is string => !!u && /^https?:\/\//i.test(u))
  return links.find((u) => parseJobUrl(u, hint)) ?? links[0] ?? null
}

/** The scout's date for the posting, as a fallback: exact from a company board's list, an estimate from a feed or Workday's "Posted 3 Days Ago". */
const scoutDate = (posting: schema.Posting | undefined) => {
  if (!posting?.postedAt) return null
  const kind = posting.sourceId ? db.select({ kind: schema.sources.kind }).from(schema.sources).where(eq(schema.sources.id, posting.sourceId)).get()?.kind : undefined
  return { postedAt: posting.postedAt, postedAtSource: `scout:${kind ?? 'board'}`, postedAtExact: !!kind && kind !== 'workday' && !AGGREGATOR_KINDS.has(kind) }
}

/** The company's board, for careers pages that carry only an ATS job id (`?gh_jid=123`): its ATS on record, else a board the scout polls for it. */
const boardHint = (companyId: string | null): { kind?: string | null; board?: string | null } => {
  if (!companyId) return {}
  const c = db.select({ kind: schema.companies.atsKind, board: schema.companies.atsBoard }).from(schema.companies).where(eq(schema.companies.id, companyId)).get()
  if (c?.kind && c.board) return c
  return db.select({ kind: schema.sources.kind, board: schema.sources.board }).from(schema.sources).where(and(eq(schema.sources.companyId, companyId), eq(schema.sources.kind, 'greenhouse'))).get() ?? {}
}

export interface CheckOptions {
  get?: Fetcher
  boards?: BoardCache
}

/** Check one application's listing now and record it. */
export const checkApplicationListing = async (id: string, o: CheckOptions = {}) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const posting = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const hint = boardHint(a.companyId)
  const url = urlFor(a, posting, hint)
  const check: ListingCheck = url
    ? await checkListing(url, { ...(o.get ? { get: o.get } : {}), ...(o.boards ? { boards: o.boards } : {}), hint })
    : { verdict: 'unknown', via: 'none', evidence: 'No job link to check' }
  const fallback = scoutDate(posting)
  if (fallback) recordPostedAt(id, fallback)
  const after = recordListingCheck(id, check)
  return { id, company: a.companyName, role: a.role, url, check, application: after }
}

/** Applications due a check: open ones in `stages`, never checked, or checked before the cutoff. */
export const dueForCheck = (o: { stages?: schema.ApplicationStage[]; staleHours?: number; ids?: string[] } = {}) => {
  const cond = [ne(A.stage, 'closed'), inArray(A.status, ['potential', 'active', 'on-hold'])]
  if (o.ids) cond.push(inArray(A.id, o.ids.length ? o.ids : ['']))
  if (o.stages) cond.push(inArray(A.stage, o.stages))
  if (o.staleHours !== undefined) {
    const stale = new Date(Date.now() - o.staleHours * 3600_000).toISOString()
    const suspect = new Date(Date.now() - Math.min(o.staleHours, SUSPECT_RECHECK_HOURS) * 3600_000).toISOString()
    cond.push(or(isNull(A.listingCheckedAt), lt(A.listingCheckedAt, stale), and(eq(A.listingStatus, 'suspect'), lt(A.listingCheckedAt, suspect)))!)
  }
  // Never-checked first, then the oldest check.
  return db.select({ id: A.id, checkedAt: A.listingCheckedAt }).from(A).where(and(...cond)).all()
    .sort((x, y) => (x.checkedAt ?? '').localeCompare(y.checkedAt ?? ''))
    .map((r) => r.id)
}

export interface RefreshOptions extends CheckOptions {
  ids?: string[]
  stages?: schema.ApplicationStage[]
  staleHours?: number
  limit?: number
  gapMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface RefreshResult {
  checked: number
  open: number
  closed: number
  suspect: number
  unknown: number
  datesAdded: number
  results: Array<{ id: string; company: string; role: string; verdict: ListingCheck['verdict']; status: string | null; postedAt: string | null; evidence: string }>
}

let running: Promise<RefreshResult> | null = null
/** True while a refresh is under way; a second one waits for it rather than doubling the calls. */
export const refreshRunning = () => running !== null

/**
 * Check many listings, one call at a time, at least `gapMs` apart for any one host, so a big
 * backfill doesn't trip an ATS's rate limit. Ashby boards are read once for all their jobs.
 */
export const refreshListings = (o: RefreshOptions = {}): Promise<RefreshResult> => {
  if (running) return running
  running = (async () => {
    const ids = dueForCheck(o).slice(0, o.limit ?? Infinity)
    const gap = o.gapMs ?? HOST_GAP_MS
    const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const boards: BoardCache = o.boards ?? new Map()
    const last = new Map<string, number>()
    const out: RefreshResult = { checked: 0, open: 0, closed: 0, suspect: 0, unknown: 0, datesAdded: 0, results: [] }
    for (const id of ids) {
      const a = getApplication(id)
      if (!a) continue
      const host = checkHost(a.jobUrl ?? a.applyUrl ?? '', undefined, boards)
      const wait = host === null ? 0 : (last.get(host) ?? -Infinity) + gap - Date.now()
      if (wait > 0) await sleep(wait)
      const r = await checkApplicationListing(id, { ...o, boards })
      if (host !== null) last.set(host, Date.now())
      const s = r.application.listingStatus
      out.checked++
      if (s === 'open') out.open++
      else if (s === 'closed') out.closed++
      else if (s === 'suspect') out.suspect++
      else out.unknown++
      if (!a.postedAt && r.application.postedAt) out.datesAdded++
      out.results.push({ id, company: a.companyName, role: a.role, verdict: r.check.verdict, status: s, postedAt: r.application.postedAt, evidence: r.application.listingEvidence ?? '' })
    }
    return out
  })().finally(() => {
    running = null
  })
  return running
}

/** The scheduled pass: a few watched applications whose check is stale. */
export const scheduledListingCheck = () => refreshListings({ stages: WATCHED, staleHours: RECHECK_HOURS, limit: 20 })
