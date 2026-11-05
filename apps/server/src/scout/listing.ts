import { Predicate } from 'effect'
import { toIsoDate } from '../ids'
import { workdayPostedAt } from './adapters'

/**
 * Is one job still up, and when was it posted? Asked of the ATS's own public API for that job, which
 * answers plainly (the job, or a 404), not of the page, whose text can read "closed" for a job
 * that's open (a description that says "no longer needs to ask") and stay up for one that's gone.
 * A page is read only for hosts with no API here, and then only for its JSON-LD.
 */

/** What one check found. */
export type Verdict =
  /** The ATS has the job and takes applications. */
  | 'open'
  /** A clear signal: the ATS says the job doesn't exist, or that it no longer takes applications. */
  | 'closed'
  /** A sign it's gone that could be a misread (gone from a board list, a page 404): two in a row close it. */
  | 'missing'
  /** Couldn't tell: a network error, a rate limit, a host we can't read. */
  | 'unknown'

export interface ListingCheck {
  verdict: Verdict
  /** Where the answer came from: 'greenhouse', 'lever', 'ashby', 'workable', 'smartrecruiters', 'workday', 'page'. */
  via: string
  /** What it saw, for the record: "HTTP 404 from boards-api.greenhouse.io", "canApply: false". */
  evidence: string
  postedAt?: string | undefined
  /** The board's own date (true) or one worked out from something vaguer, like "Posted 30+ Days Ago" (false). */
  postedAtExact?: boolean | undefined
  /** Field the date came from: 'greenhouse:first_published', 'json-ld:datePosted'. */
  postedAtSource?: string | undefined
}

export interface FetchResult {
  status: number
  text: string
}
/** HTTP GET (or POST with a JSON body). Never throws on an HTTP status; throws on a network error. */
export type Fetcher = (url: string, init?: { method?: string; body?: string }) => Promise<FetchResult>

const UA = 'Mozilla/5.0 (X11; Linux x86_64) sidedoor/1.0 (personal job search)'

export const httpFetcher: Fetcher = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    redirect: 'follow',
    headers: { 'User-Agent': UA, Accept: 'application/json, text/html;q=0.9, */*;q=0.5', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(20_000),
  })
  return { status: res.status, text: await res.text() }
}

// ---- which job a URL is -------------------------------------------------------------------

export type JobRef =
  | { kind: 'greenhouse'; board: string; id: string; eu: boolean }
  | { kind: 'lever'; board: string; id: string; eu: boolean }
  | { kind: 'ashby'; board: string; id: string }
  | { kind: 'workable'; board: string; id: string }
  | { kind: 'smartrecruiters'; board: string; id: string }
  | { kind: 'workday'; host: string; tenant: string; site: string; path: string }

/** The ATS and job id behind a job or apply URL, when it's one we can ask about directly. */
export const parseJobUrl = (raw: string | null | undefined, hint?: { kind?: string | null; board?: string | null }): JobRef | null => {
  let u: URL
  try {
    u = new URL(raw ?? '')
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p))
  if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
    const eu = host.includes('.eu.')
    // /acme/jobs/123, or the embed form /embed/job_app?for=acme&token=123
    const forBoard = u.searchParams.get('for')
    const token = u.searchParams.get('token') ?? u.searchParams.get('gh_jid')
    if (parts[0] === 'embed' && forBoard && token && /^\d+$/.test(token)) return { kind: 'greenhouse', board: forBoard, id: token, eu }
    if (parts.length >= 3 && parts[1] === 'jobs' && /^\d+$/.test(parts[2]!)) return { kind: 'greenhouse', board: parts[0]!, id: parts[2]!, eu }
    return null
  }
  // A company careers page carrying a Greenhouse id: only when we know the company's board.
  const ghJid = u.searchParams.get('gh_jid')
  if (ghJid && /^\d+$/.test(ghJid) && hint?.kind === 'greenhouse' && hint.board) return { kind: 'greenhouse', board: hint.board, id: ghJid, eu: false }
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]!)) return { kind: 'lever', board: parts[0]!, id: parts[1]!, eu: host.includes('.eu.') }
    return null
  }
  if (host === 'jobs.ashbyhq.com') {
    if (parts.length >= 2 && /^[0-9a-f-]{36}$/i.test(parts[1]!)) return { kind: 'ashby', board: parts[0]!, id: parts[1]!.toLowerCase() }
    return null
  }
  if (host === 'apply.workable.com') {
    // /acme/j/ABC123/ or /acme/j/ABC123/apply
    if (parts.length >= 3 && parts[1] === 'j') return { kind: 'workable', board: parts[0]!, id: parts[2]! }
    return null
  }
  if (host === 'jobs.smartrecruiters.com' || host === 'careers.smartrecruiters.com') {
    // /Acme/744000157540880-engineering-manager
    const id = parts[1]?.match(/^(\d{6,})/)?.[1]
    if (parts[0] && id) return { kind: 'smartrecruiters', board: parts[0], id }
    return null
  }
  const wd = host.match(/^([a-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com$/)
  if (wd) {
    // /en-US/Site/job/Location/Title_JR123(/apply)
    const rest = /^[a-z]{2}-[A-Z]{2}$/.test(parts[0] ?? '') ? parts.slice(1) : parts
    const j = rest.indexOf('job')
    if (j !== 1 || rest.length < j + 2) return null
    const tail = rest.slice(j).filter((p, i, all) => !(i === all.length - 1 && p === 'apply'))
    return { kind: 'workday', host: `${wd[1]}.${wd[2]}.myworkdayjobs.com`, tenant: wd[1]!, site: rest[0]!, path: `/${tail.map(encodeURIComponent).join('/')}` }
  }
  return null
}

// ---- the checks ----------------------------------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (Predicate.isObject(v) && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined => (Predicate.isString(v) && v ? v : undefined)
const parse = (t: string): unknown => {
  try {
    return JSON.parse(t)
  } catch {
    return undefined
  }
}

const hostOf = (url: string) => new URL(url).hostname

/** The answer for an HTTP status that isn't the job: a 404 or 410 from the ATS's API is clear, a rate limit or outage isn't. */
const notOk = (via: string, url: string, status: number): ListingCheck =>
  status === 404 || status === 410
    ? { verdict: 'closed', via, evidence: `HTTP ${status} from ${hostOf(url)}: the ATS has no such job` }
    : { verdict: 'unknown', via, evidence: `HTTP ${status} from ${hostOf(url)}` }

const dated = (date: string | undefined, source: string, exact: boolean) => {
  const iso = toIsoDate(date)
  return iso ? { postedAt: iso, postedAtSource: source, postedAtExact: exact } : {}
}

/** Board lists already read in this run (Ashby has no per-job API, so one read answers for every job on a board). */
export type BoardCache = Map<string, Promise<FetchResult>>

const greenhouse = async (r: Extract<JobRef, { kind: 'greenhouse' }>, get: Fetcher): Promise<ListingCheck> => {
  const url = `https://boards-api${r.eu ? '.eu' : ''}.greenhouse.io/v1/boards/${encodeURIComponent(r.board)}/jobs/${r.id}`
  const res = await get(url)
  if (res.status !== 200) return notOk('greenhouse', url, res.status)
  const j = obj(parse(res.text))
  if (!str(j.title)) return { verdict: 'unknown', via: 'greenhouse', evidence: `Unreadable reply from ${hostOf(url)}` }
  // first_published is when it went up; updated_at only says it was live by then.
  const date = str(j.first_published) ? dated(str(j.first_published), 'greenhouse:first_published', true) : dated(str(j.updated_at), 'greenhouse:updated_at', false)
  return { verdict: 'open', via: 'greenhouse', evidence: `Listed on Greenhouse board ${r.board}`, ...date }
}

const lever = async (r: Extract<JobRef, { kind: 'lever' }>, get: Fetcher): Promise<ListingCheck> => {
  const url = `https://api${r.eu ? '.eu' : ''}.lever.co/v0/postings/${encodeURIComponent(r.board)}/${r.id}`
  const res = await get(url)
  if (res.status !== 200) return notOk('lever', url, res.status)
  const j = obj(parse(res.text))
  if (!str(j.id)) return { verdict: 'unknown', via: 'lever', evidence: `Unreadable reply from ${hostOf(url)}` }
  const created = Predicate.isNumber(j.createdAt) ? new Date(j.createdAt).toISOString() : undefined
  return { verdict: 'open', via: 'lever', evidence: `Listed on Lever board ${r.board}`, ...dated(created, 'lever:createdAt', true) }
}

const ashbyBoard = (board: string) => `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`

const ashby = async (r: Extract<JobRef, { kind: 'ashby' }>, get: Fetcher, boards: BoardCache): Promise<ListingCheck> => {
  const url = ashbyBoard(r.board)
  if (!boards.has(url)) boards.set(url, get(url))
  const res = await boards.get(url)!
  // A missing board is a renamed board as often as a closed company: not proof the job is gone.
  if (res.status === 404) return { verdict: 'missing', via: 'ashby', evidence: `Ashby has no board "${r.board}" (HTTP 404)` }
  if (res.status !== 200) return notOk('ashby', url, res.status)
  const jobs = arr(obj(parse(res.text)).jobs).map(obj)
  if (!jobs.length) return { verdict: 'unknown', via: 'ashby', evidence: `Ashby board ${r.board} read empty` }
  const j = jobs.find((x) => str(x.id)?.toLowerCase() === r.id)
  // Ashby lists every job the board publishes, so a job missing from a full list is very likely gone,
  // but an unlisted job can still take applications: two misses in a row close it.
  if (!j) return { verdict: 'missing', via: 'ashby', evidence: `Not among the ${jobs.length} jobs on Ashby board ${r.board}` }
  return { verdict: 'open', via: 'ashby', evidence: `Listed on Ashby board ${r.board}${j.isListed === false ? ' (unlisted, link only)' : ''}`, ...dated(str(j.publishedAt), 'ashby:publishedAt', true) }
}

const workable = async (r: Extract<JobRef, { kind: 'workable' }>, get: Fetcher): Promise<ListingCheck> => {
  const url = `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(r.board)}/jobs/${encodeURIComponent(r.id)}`
  const res = await get(url)
  if (res.status !== 200) return notOk('workable', url, res.status)
  const j = obj(parse(res.text))
  if (!str(j.shortcode) && !str(j.title)) return { verdict: 'unknown', via: 'workable', evidence: `Unreadable reply from ${hostOf(url)}` }
  const state = str(j.state)
  const date = dated(str(j.published), 'workable:published', true)
  if (state && state !== 'published') return { verdict: 'closed', via: 'workable', evidence: `Workable says the job is ${state}`, ...date }
  return { verdict: 'open', via: 'workable', evidence: `Published on Workable account ${r.board}`, ...date }
}

const smartrecruiters = async (r: Extract<JobRef, { kind: 'smartrecruiters' }>, get: Fetcher): Promise<ListingCheck> => {
  const url = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(r.board)}/postings/${r.id}`
  const res = await get(url)
  if (res.status !== 200) return notOk('smartrecruiters', url, res.status)
  const j = obj(parse(res.text))
  if (!str(j.id)) return { verdict: 'unknown', via: 'smartrecruiters', evidence: `Unreadable reply from ${hostOf(url)}` }
  const date = dated(str(j.releasedDate), 'smartrecruiters:releasedDate', true)
  if (j.active === false) return { verdict: 'closed', via: 'smartrecruiters', evidence: 'SmartRecruiters says the posting is no longer active', ...date }
  return { verdict: 'open', via: 'smartrecruiters', evidence: `Active on SmartRecruiters (${r.board})`, ...date }
}

const workday = async (r: Extract<JobRef, { kind: 'workday' }>, get: Fetcher): Promise<ListingCheck> => {
  const url = `https://${r.host}/wday/cxs/${r.tenant}/${r.site}${r.path}`
  const res = await get(url)
  if (res.status !== 200) return notOk('workday', url, res.status)
  const i = obj(obj(parse(res.text)).jobPostingInfo)
  if (!str(i.title)) return { verdict: 'unknown', via: 'workday', evidence: `Unreadable reply from ${r.host}` }
  // startDate is the day it was posted; "Posted 30+ Days Ago" is only a bound.
  const date = str(i.startDate) ? dated(str(i.startDate), 'workday:startDate', true) : dated(workdayPostedAt(str(i.postedOn)), 'workday:postedOn', false)
  if (i.canApply === false || i.posted === false) return { verdict: 'closed', via: 'workday', evidence: `Workday says ${i.canApply === false ? 'canApply: false' : 'posted: false'}: no longer accepting applications`, ...date }
  return { verdict: 'open', via: 'workday', evidence: `Open on Workday (${r.tenant}/${r.site})`, ...date }
}

// ---- any other page ------------------------------------------------------------------------

/** JobPosting objects in a page's JSON-LD, wherever they sit (top level, an array, an @graph). */
export const jsonLdJobPostings = (html: string): Obj[] => {
  const out: Obj[] = []
  const visit = (v: unknown) => {
    if (Array.isArray(v)) return v.forEach(visit)
    const o = obj(v)
    const type = o['@type']
    if (type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'))) out.push(o)
    if (o['@graph']) visit(o['@graph'])
  }
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) visit(parse(m[1]!.trim()))
  return out
}

/**
 * Phrases a careers page shows in place of a job that's gone. Whole sentences, so a description
 * that happens to say "no longer" doesn't count.
 */
const GONE_TEXT =
  /(no longer (accepting|taking) applications|this (job|position|role|posting|opening|requisition) (is no longer available|has (been )?(closed|filled|expired)|is closed|is no longer open)|the (job|position) you('re| are) looking for (is no longer|has been|no longer))/i

const page = async (url: string, get: Fetcher): Promise<ListingCheck> => {
  const res = await get(url)
  if (res.status === 404 || res.status === 410) return { verdict: 'missing', via: 'page', evidence: `The job page answers HTTP ${res.status}` }
  if (res.status !== 200) return { verdict: 'unknown', via: 'page', evidence: `The job page answers HTTP ${res.status}` }
  const posting = jsonLdJobPostings(res.text)[0]
  const date = posting ? dated(str(posting.datePosted), 'json-ld:datePosted', true) : {}
  const text = res.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
  const gone = text.match(GONE_TEXT)?.[0]
  if (gone) return { verdict: 'missing', via: 'page', evidence: `The job page says "${gone}"`, ...date }
  const until = posting ? toIsoDate(str(posting.validThrough)) : null
  if (until && Date.parse(until) < Date.now()) return { verdict: 'missing', via: 'page', evidence: `The page's JSON-LD says it was valid through ${until.slice(0, 10)}`, ...date }
  // A page with no API behind it can't prove a job open; a JobPosting on it is the best sign there is.
  if (posting) return { verdict: 'open', via: 'page', evidence: 'The job page carries a JobPosting (JSON-LD)', ...date }
  return { verdict: 'unknown', via: 'page', evidence: "Can't tell from the page: no JobPosting data and no closed notice", ...date }
}

/** Check one job. Never throws: a failure to ask is 'unknown'. */
export const checkListing = async (url: string, o: { get?: Fetcher; boards?: BoardCache; hint?: { kind?: string | null; board?: string | null } } = {}): Promise<ListingCheck> => {
  const get = o.get ?? httpFetcher
  const boards = o.boards ?? new Map()
  const ref = parseJobUrl(url, o.hint)
  try {
    switch (ref?.kind) {
      case 'greenhouse':
        return await greenhouse(ref, get)
      case 'lever':
        return await lever(ref, get)
      case 'ashby':
        return await ashby(ref, get, boards)
      case 'workable':
        return await workable(ref, get)
      case 'smartrecruiters':
        return await smartrecruiters(ref, get)
      case 'workday':
        return await workday(ref, get)
      default:
        return await page(url, get)
    }
  } catch (e) {
    return { verdict: 'unknown', via: ref?.kind ?? 'page', evidence: `Couldn't reach it: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300) }
  }
}

/**
 * The API host a check will call, for spacing calls to one host (see `refreshListings`), or null
 * when it needs no call: an Ashby board already read this run.
 */
export const checkHost = (url: string, hint?: { kind?: string | null; board?: string | null }, boards?: BoardCache) => {
  const r = parseJobUrl(url, hint)
  if (r?.kind === 'ashby' && boards?.has(ashbyBoard(r.board))) return null
  if (!r) {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  }
  if (r.kind === 'workday') return r.host
  return { greenhouse: 'boards-api.greenhouse.io', lever: 'api.lever.co', ashby: 'api.ashbyhq.com', workable: 'apply.workable.com', smartrecruiters: 'api.smartrecruiters.com' }[r.kind]
}
