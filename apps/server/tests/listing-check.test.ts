import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { describe, expect, test, vi } from 'vitest'
import { db, schema } from '../src/db/client'
import { newId } from '../src/ids'
import { checkApplicationListing, dueForCheck, refreshListings } from '../src/jobs/listing-check'
import { reconcile } from '../src/jobs/runner'
import { toolsFor } from '../src/mcp/tools'
import { getApplicationDetail } from '../src/queries'
import { checkListing, type Fetcher, parseJobUrl } from '../src/scout/listing'
import { createApplication, getApplication } from '../src/services/applications'
import { listingClosedAt, nextListing, nextPostedAt, recordListingCheck } from '../src/services/listings'

/**
 * Responses recorded from the ATSs' public APIs on 2026-10-30 (tests/fixtures/listings), trimmed to
 * the fields the checks read. Each test serves them by URL; anything else is a network error.
 */
const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/listings', name), 'utf8')
type Route = { status: number; file?: string; text?: string }
const serve = (routes: Record<string, Route>): Fetcher & { calls: string[] } => {
  const calls: string[] = []
  const f = async (url: string) => {
    calls.push(url)
    const r = routes[url]
    if (!r) throw new Error(`fetch failed: ${url}`)
    return { status: r.status, text: r.text ?? (r.file ? fixture(r.file) : '') }
  }
  return Object.assign(f, { calls })
}

const GH = 'https://boards-api.greenhouse.io/v1/boards/edgeco/jobs'
const LV = 'https://api.lever.co/v0/postings/solarco'
const ASHBY_TASKLY = 'https://api.ashbyhq.com/posting-api/job-board/taskly'
const ASHBY_FITLY = 'https://api.ashbyhq.com/posting-api/job-board/fitly'
const WK = 'https://apply.workable.com/api/v2/accounts/dataco/jobs'
const SR = 'https://api.smartrecruiters.com/v1/companies/wcginternationalconsultantsltd/postings'
const WD = 'https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara'
const WD_JOB = 'Senior-Account-Manager--Supercomputing-and-Global-Public-Sector-and-US-Federal-Government_JR2028625'
const TASKLY_EM = 'https://jobs.ashbyhq.com/taskly/c252ee33-b277-474e-963d-7fb64004c8a0'

const ROUTES: Record<string, Route> = {
  [`${GH}/8185558`]: { status: 200, file: 'greenhouse-job.json' },
  [`${GH}/1`]: { status: 404, file: 'greenhouse-404.json' },
  [`${LV}/631c2c22-0759-4f84-a9a1-11305917c510`]: { status: 200, file: 'lever-posting.json' },
  [`${LV}/00000000-0759-4f84-a9a1-11305917c510`]: { status: 404, file: 'lever-404.json' },
  [ASHBY_TASKLY]: { status: 200, file: 'ashby-taskly-board.json' },
  [ASHBY_FITLY]: { status: 200, file: 'ashby-fitly-board.json' },
  [`${WK}/1378093793`]: { status: 200, file: 'workable-job.json' },
  [`${WK}/ZZZZ000000`]: { status: 404, file: 'workable-404.txt' },
  [`${SR}/3743990016023136`]: { status: 200, file: 'smartrecruiters-posting.json' },
  [`${SR}/1111111111111111`]: { status: 404, file: 'smartrecruiters-404.json' },
  [`${WD}/${WD_JOB}`]: { status: 200, file: 'workday-job.json' },
  [`${WD}/Nonexistent-Job_JR0000001`]: { status: 404, file: 'workday-404.json' },
  'https://careers.acme.test/jobs/em': { status: 200, file: 'page-jsonld.html' },
  'https://careers.acme.test/jobs/sr-eng': { status: 200, file: 'page-misleading.html' },
  'https://careers.acme.test/jobs/gone': { status: 404, text: 'Not found' },
  'https://careers.acme.test/jobs/busy': { status: 429, text: 'Too many requests' },
}

describe('which job a URL is', () => {
  test('each ATS URL shape names its board and job', () => {
    expect(parseJobUrl('https://job-boards.greenhouse.io/drawly/jobs/6010279004?gh_jid=6010279004')).toEqual({ kind: 'greenhouse', board: 'drawly', id: '6010279004', eu: false })
    expect(parseJobUrl('https://boards.greenhouse.io/embed/job_app?for=acme&token=123')).toMatchObject({ kind: 'greenhouse', board: 'acme', id: '123' })
    expect(parseJobUrl('https://jobs.lever.co/solarco/631c2c22-0759-4f84-a9a1-11305917c510/apply')).toMatchObject({ kind: 'lever', board: 'solarco' })
    expect(parseJobUrl(TASKLY_EM)).toEqual({ kind: 'ashby', board: 'taskly', id: 'c252ee33-b277-474e-963d-7fb64004c8a0' })
    expect(parseJobUrl('https://apply.workable.com/dataco/j/1378093793/')).toEqual({ kind: 'workable', board: 'dataco', id: '1378093793' })
    expect(parseJobUrl('https://jobs.smartrecruiters.com/tenmilesquaretechnologies/744000157540880-engineering-team-lead-sdet-')).toEqual({ kind: 'smartrecruiters', board: 'tenmilesquaretechnologies', id: '744000157540880' })
    expect(parseJobUrl(`https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/${WD_JOB}/apply`)).toEqual({
      kind: 'workday',
      host: 'nvidia.wd5.myworkdayjobs.com',
      tenant: 'nvidia',
      site: 'NVIDIAExternalCareerSite',
      path: `/job/US-CA-Santa-Clara/${WD_JOB}`,
    })
  })

  test("a careers page's gh_jid counts only when the company's Greenhouse board is known; board pages aren't jobs", () => {
    expect(parseJobUrl('https://www.acme.test/careers?gh_jid=555')).toBeNull()
    expect(parseJobUrl('https://www.acme.test/careers?gh_jid=555', { kind: 'greenhouse', board: 'acme' })).toMatchObject({ kind: 'greenhouse', board: 'acme', id: '555' })
    expect(parseJobUrl('https://jobs.ashbyhq.com/taskly')).toBeNull()
    expect(parseJobUrl('https://recruiting.paylocity.com/recruiting/jobs/Details/4272355')).toBeNull()
  })
})

describe('each ATS: is it up, and when was it posted', () => {
  const get = serve(ROUTES)
  const check = (url: string) => checkListing(url, { get })

  test('Greenhouse: the job with its first_published date; a 404 is closed', async () => {
    expect(await check('https://job-boards.greenhouse.io/edgeco/jobs/8185558')).toMatchObject({ verdict: 'open', via: 'greenhouse', postedAt: '2026-09-16T11:37:45-04:00', postedAtSource: 'greenhouse:first_published', postedAtExact: true })
    expect(await check('https://job-boards.greenhouse.io/edgeco/jobs/1')).toMatchObject({ verdict: 'closed', evidence: expect.stringContaining('HTTP 404') })
  })

  test('Lever: createdAt; a 404 is closed', async () => {
    expect(await check('https://jobs.lever.co/solarco/631c2c22-0759-4f84-a9a1-11305917c510')).toMatchObject({ verdict: 'open', postedAt: new Date(1786483968452).toISOString(), postedAtSource: 'lever:createdAt', postedAtExact: true })
    expect((await check('https://jobs.lever.co/solarco/00000000-0759-4f84-a9a1-11305917c510')).verdict).toBe('closed')
  })

  test("Ashby: publishedAt from the board; a job missing from the board is only a miss, since there's no per-job API", async () => {
    expect(await check(TASKLY_EM)).toMatchObject({ verdict: 'open', via: 'ashby', postedAt: '2026-01-07T15:12:39.531+00:00', postedAtSource: 'ashby:publishedAt', postedAtExact: true })
    expect(await check('https://jobs.ashbyhq.com/fitly/ea69e10c-256e-4d48-9823-61d27409349e')).toMatchObject({ verdict: 'missing', evidence: 'Not among the 8 jobs on Ashby board fitly' })
  })

  test('Workable: published and state; a 404 is closed, so is a state other than published', async () => {
    expect(await check('https://apply.workable.com/dataco/j/1378093793/')).toMatchObject({ verdict: 'open', postedAt: '2026-09-10T00:00:00.000Z', postedAtSource: 'workable:published' })
    expect((await check('https://apply.workable.com/dataco/j/ZZZZ000000/')).verdict).toBe('closed')
    const archived = serve({ [`${WK}/1378093793`]: { status: 200, text: fixture('workable-job.json').replace('"published"', '"archived"') } })
    expect(await checkListing('https://apply.workable.com/dataco/j/1378093793', { get: archived })).toMatchObject({ verdict: 'closed', evidence: 'Workable says the job is archived' })
  })

  test('SmartRecruiters: releasedDate; a 404 or active: false is closed', async () => {
    expect(await check('https://jobs.smartrecruiters.com/wcginternationalconsultantsltd/3743990016023136-platform-engineering-manager')).toMatchObject({ verdict: 'open', postedAt: '2026-10-09T16:14:06.608Z', postedAtSource: 'smartrecruiters:releasedDate' })
    expect((await check('https://jobs.smartrecruiters.com/wcginternationalconsultantsltd/1111111111111111-gone')).verdict).toBe('closed')
    const inactive = serve({ [`${SR}/3743990016023136`]: { status: 200, text: fixture('smartrecruiters-posting.json').replace('"active": true', '"active": false') } })
    expect((await checkListing('https://jobs.smartrecruiters.com/wcginternationalconsultantsltd/3743990016023136-x', { get: inactive })).verdict).toBe('closed')
  })

  test('Workday: startDate is exact, "Posted 30+ Days Ago" an estimate; canApply: false or a 404 is closed', async () => {
    const url = `https://nvidia.wd5.myworkdayjobs.com/en-US/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/${WD_JOB}`
    expect(await check(url)).toMatchObject({ verdict: 'open', postedAt: '2026-10-30', postedAtSource: 'workday:startDate', postedAtExact: true })
    const vague = serve({ [`${WD}/${WD_JOB}`]: { status: 200, text: fixture('workday-job.json').replace('"startDate": "2026-10-30",', '').replace('Posted Today', 'Posted 30+ Days Ago') } })
    expect(await checkListing(url, { get: vague })).toMatchObject({ verdict: 'open', postedAtSource: 'workday:postedOn', postedAtExact: false })
    const shut = serve({ [`${WD}/${WD_JOB}`]: { status: 200, text: fixture('workday-job.json').replace('"canApply": true', '"canApply": false') } })
    expect(await checkListing(url, { get: shut })).toMatchObject({ verdict: 'closed', evidence: expect.stringContaining('no longer accepting') })
    expect((await check('https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/US-CA-Santa-Clara/Nonexistent-Job_JR0000001')).verdict).toBe('closed')
  })

  test("any other page: JSON-LD datePosted; a 404 is only a miss, and a description that says \"no longer\" isn't a closed notice", async () => {
    expect(await check('https://careers.acme.test/jobs/em')).toMatchObject({ verdict: 'open', via: 'page', postedAt: '2026-01-07', postedAtSource: 'json-ld:datePosted', postedAtExact: true })
    expect((await check('https://careers.acme.test/jobs/sr-eng')).verdict).toBe('unknown')
    expect((await check('https://careers.acme.test/jobs/gone')).verdict).toBe('missing')
    const closedPage = serve({ 'https://careers.acme.test/jobs/x': { status: 200, text: '<html><body><h2>This job is no longer available.</h2></body></html>' } })
    expect((await checkListing('https://careers.acme.test/jobs/x', { get: closedPage })).verdict).toBe('missing')
  })

  test("a rate limit, an outage or a network error says nothing about the job", async () => {
    expect((await check('https://careers.acme.test/jobs/busy')).verdict).toBe('unknown')
    expect((await check('https://job-boards.greenhouse.io/edgeco/jobs/999')).verdict).toBe('unknown')
    const down = serve({ [`${GH}/8185558`]: { status: 503, text: '' } })
    expect((await checkListing('https://job-boards.greenhouse.io/edgeco/jobs/8185558', { get: down })).verdict).toBe('unknown')
  })
})

describe('what a check means for the listing', () => {
  const fresh = { postedAt: null, postedAtSource: null, postedAtExact: null, listingStatus: null, listingMisses: 0, listingClosedAt: null }
  const at = '2026-10-30T12:00:00.000Z'
  const miss = { verdict: 'missing' as const, via: 'page', evidence: 'HTTP 404' }

  test('one ambiguous miss is a suspicion; the second in a row closes it; an open check starts over', () => {
    const one = nextListing(fresh, miss, at)
    expect(one).toMatchObject({ listingStatus: 'suspect', listingMisses: 1 })
    expect(one.listingClosedAt).toBeUndefined()
    // Couldn't tell in between: the count stands, neither reset nor raised.
    const between = nextListing({ ...fresh, listingStatus: 'suspect', listingMisses: 1 }, { verdict: 'unknown', via: 'page', evidence: 'HTTP 429' }, at)
    expect(between).toMatchObject({ listingStatus: 'suspect' })
    expect(between.listingMisses).toBeUndefined()
    expect(nextListing({ ...fresh, listingStatus: 'suspect', listingMisses: 1 }, miss, at)).toMatchObject({ listingStatus: 'closed', listingMisses: 2, listingClosedAt: at })
    expect(nextListing({ ...fresh, listingStatus: 'suspect', listingMisses: 1 }, { verdict: 'open', via: 'ashby', evidence: 'listed' }, at)).toMatchObject({ listingStatus: 'open', listingMisses: 0, listingClosedAt: null })
  })

  test('a clear signal closes it at once', () => {
    expect(nextListing(fresh, { verdict: 'closed', via: 'greenhouse', evidence: 'HTTP 404' }, at)).toMatchObject({ listingStatus: 'closed', listingClosedAt: at, listingEvidence: 'greenhouse: HTTP 404' })
  })

  test("the ATS's own date beats a page's, which beats an estimate; an estimate never replaces an exact date", () => {
    const estimated = { postedAt: '2026-09-01', postedAtSource: 'workday:postedOn', postedAtExact: false }
    const page = { postedAt: '2026-09-03', postedAtSource: 'json-ld:datePosted', postedAtExact: true }
    const ats = { postedAt: '2026-09-02T10:00:00Z', postedAtSource: 'greenhouse:first_published', postedAtExact: true }
    expect(nextPostedAt(fresh, estimated)).toEqual(estimated)
    expect(nextPostedAt({ ...fresh, ...estimated }, page)).toEqual(page)
    expect(nextPostedAt({ ...fresh, ...page }, ats)).toEqual(ats)
    expect(nextPostedAt({ ...fresh, ...ats }, page)).toEqual({})
    expect(nextPostedAt({ ...fresh, ...ats }, estimated)).toEqual({})
    expect(nextPostedAt({ ...fresh, ...ats }, { ...ats, postedAt: '2026-09-02T11:00:00Z' })).toMatchObject({ postedAt: '2026-09-02T11:00:00Z' })
  })
})

/** A posting the old scout closed when the listing rolled off an aggregator's feed, though the company still lists it. */
const aggregatorCopy = (url: string, closedAt: string | null) => {
  const sourceId = newId('src_')
  db.insert(schema.sources).values({ id: sourceId, name: 'Jobicy', kind: 'rss', board: `https://jobicy.test/${sourceId}`, status: 'active' }).run()
  const id = newId('job_')
  db.insert(schema.postings).values({ id, key: `rss:${id}`, sourceId, title: 'Engineering Manager (Frontend)', companyName: 'Taskly', url, applyUrl: url, viaUrl: 'https://jobicy.test/jobs/151249', firstSeenAt: '2026-10-26T01:36:12.231Z', lastSeenAt: '2026-10-26T01:36:12.231Z', closedAt }).run()
  return id
}
const posting = (id: string) => db.select().from(schema.postings).where(eq(schema.postings.id, id)).get()!

describe('the Taskly case: closed in Sidedoor, open on the board', () => {
  test("the Ashby board says it's up: the listing reopens, its date fills in, and nothing flags it", async () => {
    const postingId = aggregatorCopy(TASKLY_EM, '2026-10-27T06:47:47.312Z')
    const app = createApplication({ companyName: 'Taskly', role: 'Engineering Manager (Frontend)', stage: 'review', status: 'potential', postingId, jobUrl: TASKLY_EM, applyUrl: TASKLY_EM, packageMd: '# Taskly' })
    expect(getApplicationDetail(app.id)?.listingClosedAt).toBe('2026-10-27T06:47:47.312Z')

    const r = await checkApplicationListing(app.id, { get: serve(ROUTES) })
    expect(r.check.verdict).toBe('open')
    expect(getApplication(app.id)).toMatchObject({ listingStatus: 'open', listingMisses: 0, listingClosedAt: null, postedAt: '2026-01-07T15:12:39.531+00:00', postedAtSource: 'ashby:publishedAt', postedAtExact: true, stage: 'review' })
    expect(posting(postingId)).toMatchObject({ closedAt: null })
    expect(getApplicationDetail(app.id)?.listingClosedAt).toBeNull()
  })

  test('the scout seeing the posting go after the check still counts; a check before it does not hide it', () => {
    const postingId = aggregatorCopy(TASKLY_EM, null)
    const a = { listingStatus: 'open' as const, listingClosedAt: null, listingCheckedAt: '2026-10-29T00:00:00.000Z' }
    expect(listingClosedAt(a, { closedAt: '2026-10-30T00:00:00.000Z' })).toBe('2026-10-30T00:00:00.000Z')
    expect(listingClosedAt(a, { closedAt: '2026-10-28T00:00:00.000Z' })).toBeNull()
    expect(posting(postingId).closedAt).toBeNull()
  })

  test('a job missing from its board once is flagged as suspect, not closed; two misses close it and reconcile flags it', async () => {
    const url = 'https://jobs.ashbyhq.com/fitly/ea69e10c-256e-4d48-9823-61d27409349e'
    const app = createApplication({ companyName: 'Fitly', role: 'Engineer', stage: 'review', status: 'potential', jobUrl: url, packageMd: '# Fitly' })
    await checkApplicationListing(app.id, { get: serve(ROUTES) })
    expect(getApplication(app.id)).toMatchObject({ listingStatus: 'suspect', listingMisses: 1, listingClosedAt: null })
    reconcile()
    expect(getApplication(app.id)?.stage).toBe('review')
    await checkApplicationListing(app.id, { get: serve(ROUTES) })
    expect(getApplication(app.id)).toMatchObject({ listingStatus: 'closed', listingMisses: 2 })
    expect(getApplicationDetail(app.id)?.listingClosedAt).not.toBeNull()
  })

  test("a closed listing closes an application you'd only marked interested, as a closed posting does", () => {
    const app = createApplication({ companyName: 'Gone Inc', role: 'Engineer', stage: 'interested', status: 'potential', jobUrl: 'https://job-boards.greenhouse.io/gone/jobs/1' })
    recordListingCheck(app.id, { verdict: 'closed', via: 'greenhouse', evidence: 'HTTP 404' })
    reconcile()
    expect(getApplication(app.id)).toMatchObject({ stage: 'closed', closedReason: 'Listing closed' })
  })
})

describe('the backfill', () => {
  const ALLOWED = new Set(['postedAt', 'postedAtSource', 'postedAtExact', 'listingStatus', 'listingCheckedAt', 'listingEvidence', 'listingMisses', 'listingClosedAt'])

  test('fills in dates and status across open applications and changes nothing else', async () => {
    const mk = (role: string, jobUrl: string | null, stage: schema.ApplicationStage = 'review') =>
      createApplication({ companyName: 'Backfill Co', role, stage, status: stage === 'applied' ? 'active' : 'potential', jobUrl, applyUrl: jobUrl, packageMd: `# ${role}`, notesMd: 'notes', nextAction: 'Review it', nextActionDate: '2026-10-30', rank: 3, shot: 40 }).id
    const ids = [
      mk('GH', 'https://job-boards.greenhouse.io/edgeco/jobs/8185558'),
      mk('Lever', 'https://jobs.lever.co/solarco/631c2c22-0759-4f84-a9a1-11305917c510', 'applied'),
      mk('Ashby', TASKLY_EM),
      mk('Workable', 'https://apply.workable.com/dataco/j/1378093793/', 'interested'),
      mk('SR', 'https://jobs.smartrecruiters.com/wcginternationalconsultantsltd/3743990016023136-platform-engineering-manager'),
      mk('Page', 'https://careers.acme.test/jobs/em'),
      mk('Busy', 'https://careers.acme.test/jobs/busy'),
      mk('No link', null),
    ]
    const before = new Map(ids.map((id) => [id, getApplication(id)!]))
    const r = await refreshListings({ ids, get: serve(ROUTES), gapMs: 0 })
    expect(r.checked).toBe(ids.length)
    expect(r.datesAdded).toBe(6)
    for (const id of ids) {
      const was = before.get(id)!
      const now = getApplication(id)!
      const changed = Object.keys(now).filter((k) => JSON.stringify(now[k as keyof typeof now]) !== JSON.stringify(was[k as keyof typeof was]))
      expect(changed.filter((k) => !ALLOWED.has(k)), `${now.role} changed more than its listing fields`).toEqual([])
    }
    expect(getApplication(ids[0]!)).toMatchObject({ postedAtSource: 'greenhouse:first_published', listingStatus: 'open' })
    expect(getApplication(ids[6]!)).toMatchObject({ listingStatus: 'unknown', postedAt: null })
    expect(getApplication(ids[7]!)).toMatchObject({ listingStatus: 'unknown', listingEvidence: 'none: No job link to check' })
  })

  test('calls to one host are spaced out; an Ashby board is read once for all its jobs', async () => {
    const urls = ['https://job-boards.greenhouse.io/edgeco/jobs/8185558', 'https://job-boards.greenhouse.io/edgeco/jobs/1', TASKLY_EM, 'https://jobs.ashbyhq.com/taskly/9fcbf37a-9860-4013-b98c-4c2b62cd5cbf']
    const ids = urls.map((u, i) => createApplication({ companyName: 'Spacing', role: `R${i}`, stage: 'review', status: 'potential', jobUrl: u }).id)
    const waits: number[] = []
    const get = serve(ROUTES)
    await refreshListings({ ids, get, gapMs: 60_000, sleep: async (ms) => void waits.push(ms) })
    // The second Greenhouse call waits; the first Ashby call doesn't (another host); the second Ashby job needs no call at all.
    expect(waits.length).toBe(1)
    expect(waits.every((w) => w > 59_000)).toBe(true)
    expect(get.calls.filter((c) => c === ASHBY_TASKLY).length).toBe(1)
  })

  test("the schedule skips what was checked lately, but looks again soon at a listing that missed once", () => {
    const recent = createApplication({ companyName: 'Due Co', role: 'Recent', stage: 'review', status: 'potential', jobUrl: TASKLY_EM }).id
    const suspect = createApplication({ companyName: 'Due Co', role: 'Suspect', stage: 'review', status: 'potential', jobUrl: TASKLY_EM }).id
    const old = createApplication({ companyName: 'Due Co', role: 'Old', stage: 'review', status: 'potential', jobUrl: TASKLY_EM }).id
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
    recordListingCheck(recent, { verdict: 'open', via: 'ashby', evidence: 'listed' }, { at: hoursAgo(1) })
    recordListingCheck(suspect, { verdict: 'missing', via: 'ashby', evidence: 'not listed' }, { at: hoursAgo(5) })
    recordListingCheck(old, { verdict: 'open', via: 'ashby', evidence: 'listed' }, { at: hoursAgo(30) })
    const due = dueForCheck({ ids: [recent, suspect, old], staleHours: 24 })
    expect(due.sort()).toEqual([suspect, old].sort())
  })
})

describe('agents', () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const t = toolsFor('grokbot').find((x) => x.name === name)!
    const r = await t.handler(args)
    const text = r.content[0]!.text
    return text.startsWith('Error') ? text : (JSON.parse(text) as unknown)
  }

  test('check_listing checks one now; list_applications then finds it by when it was posted', async () => {
    vi.stubGlobal('fetch', async (url: string) => {
      const r = ROUTES[url]
      if (!r) throw new Error(`fetch failed: ${url}`)
      return new Response(r.text ?? (r.file ? fixture(r.file) : ''), { status: r.status })
    })
    try {
      const app = createApplication({ companyName: 'Agent Co', role: 'Engineering Manager (Frontend)', stage: 'review', status: 'potential', jobUrl: TASKLY_EM })
      const undatedBefore = (await call('list_applications', { undated: true })) as Array<{ id: string }>
      expect(undatedBefore.map((a) => a.id)).toContain(app.id)
      expect(await call('check_listing', { applicationId: app.id })).toMatchObject({ verdict: 'open', postedAt: '2026-01-07T15:12:39.531+00:00', postedAtSource: 'ashby:publishedAt', postedAtExact: true, listing: { status: 'open' } })
      const old = (await call('list_applications', { postedBefore: '2026-02-01' })) as Array<{ id: string }>
      expect(old.map((a) => a.id)).toContain(app.id)
      expect(((await call('list_applications', { postedBefore: '2026-01-01' })) as Array<{ id: string }>).map((a) => a.id)).not.toContain(app.id)
      expect(((await call('list_applications', { undated: true })) as Array<{ id: string }>).map((a) => a.id)).not.toContain(app.id)
      expect(await call('check_listing', {})).toMatch(/Give applicationId/)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

test("a careers page with only a gh_jid is checked on the company's Greenhouse board, found through the board the scout polls", async () => {
  const companyId = newId('co_')
  db.insert(schema.companies).values({ id: companyId, name: 'Edgeco', slug: `edgeco-${companyId}` }).run()
  db.insert(schema.sources).values({ id: newId('src_'), name: 'Edgeco', kind: 'greenhouse', board: 'edgeco', companyId, status: 'active' }).run()
  const app = createApplication({ companyId, companyName: 'Edgeco', role: 'EM', stage: 'review', status: 'potential', jobUrl: 'https://www.edgeco.com/careers/jobs/?gh_jid=8185558' })
  const r = await checkApplicationListing(app.id, { get: serve(ROUTES) })
  expect(r.check).toMatchObject({ verdict: 'open', via: 'greenhouse', postedAtSource: 'greenhouse:first_published' })
})
