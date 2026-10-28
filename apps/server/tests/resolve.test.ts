import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { buildLocationFilters } from '../src/scout/filters'
import { updateSettings } from '../src/settings'
import { db, schema } from '../src/db/client'
import { newId, nowIso } from '../src/ids'
import type { RawJob } from '../src/scout/adapters'
import { parseRss } from '../src/scout/adapters'
import { matchTitle, resolveAggregatorPostings } from '../src/scout/resolve'
import { scan } from '../src/scout/scan'
import { createApplication, getApplication } from '../src/services/applications'

const BOARD: RawJob[] = [
  { extId: 'a1', title: 'Director, Software Engineering (AI Workflows)', location: 'Remote', url: 'https://jobs.ashbyhq.com/jobber/a1', applyUrl: 'https://jobs.ashbyhq.com/jobber/a1/application', jd: 'Full JD one. '.repeat(50) },
  { extId: 'a2', title: 'Director, Software Engineering (AI Workflows & Ecosystem)', location: 'Remote', url: 'https://jobs.ashbyhq.com/jobber/a2', applyUrl: 'https://jobs.ashbyhq.com/jobber/a2/application', jd: 'Full JD two. '.repeat(50), comp: '$200K – $250K' },
  { extId: 'a3', title: 'Manager, Software Engineering, Operations', location: 'Toronto', url: 'https://jobs.ashbyhq.com/jobber/a3', applyUrl: 'https://jobs.ashbyhq.com/jobber/a3/application', jd: 'Full JD three. '.repeat(50) },
  { extId: 'a4', title: 'Senior Engineering Manager, Platform', location: 'Europe | Remote', url: 'https://jobs.ashbyhq.com/jobber/a4', applyUrl: 'https://jobs.ashbyhq.com/jobber/a4/application', jd: 'Full JD four. '.repeat(50) },
]
/** What the mocked Jobicy feed returns on the next scan. */
let FEED: RawJob[] = []

vi.mock('../src/scout/adapters', async (orig) => {
  const real = await orig<typeof import('../src/scout/adapters')>()
  const ashby = (board: string) => (board === 'jobber' ? Effect.succeed(BOARD) : Effect.fail(new real.FetchError(board, 404, 'HTTP 404')))
  return {
    ...real,
    ADAPTERS: { ...real.ADAPTERS, ashby, rss: () => Effect.succeed(FEED) },
    probeBoard: (token: string) => Effect.succeed(token === 'jobber' ? { kind: 'ashby' as const, board: 'jobber', jobs: BOARD } : null),
  }
})

const jobicy = (() => {
  db.insert(schema.sources).values({ id: 'src_jobicy', name: 'Jobicy', kind: 'rss', board: 'https://jobicy.com/feed', status: 'active' }).run()
  return 'src_jobicy'
})()

const listing = (title: string, slug: string, o: Partial<typeof schema.postings.$inferInsert> = {}) => {
  const id = newId('job_')
  const url = `https://jobicy.com/jobs/${slug}`
  db.insert(schema.postings)
    .values({ id, key: `rss:jobicy:${slug}`, sourceId: jobicy, companyName: 'Jobber', title, url, applyUrl: url, jd: 'Short teaser…', firstSeenAt: nowIso(), lastSeenAt: nowIso(), triageStatus: 'pending', ...o })
    .run()
  return id
}
const posting = (id: string) => db.select().from(schema.postings).where(eq(schema.postings.id, id)).get()!

describe('title matching', () => {
  test('exact title wins over a near one', () => {
    expect(matchTitle('Director, Software Engineering (AI Workflows & Ecosystem)', BOARD)?.extId).toBe('a2')
    expect(matchTitle('Director, Software Engineering (AI Workflows)', BOARD)?.extId).toBe('a1')
  })
  test('punctuation, "&", "Sr." and a trailing "(Remote)" do not matter', () => {
    expect(matchTitle('Director Software Engineering - AI Workflows and Ecosystem (Remote)', BOARD)?.extId).toBe('a2')
    expect(matchTitle('Sr. Engineer', [{ ...BOARD[0]!, title: 'Senior Engineer' }])?.title).toBe('Senior Engineer')
  })
  test('a trailing "at Company" is ignored', () => {
    expect(matchTitle('Manager, Software Engineering, Operations at Jobber', BOARD, 'Jobber')?.extId).toBe('a3')
  })
  test('a different role is not a match', () => {
    expect(matchTitle('Director, Sales Enablement', BOARD)).toBeNull()
  })
})

describe('resolving aggregator listings', () => {
  test('swaps in the company posting, keeps the aggregator link, and offers the board as a source', async () => {
    const id = listing('Director, Software Engineering (AI Workflows & Ecosystem)', '153621-director')
    const a = createApplication({ companyName: 'Jobber', role: 'Director', jobUrl: posting(id).url, applyUrl: posting(id).applyUrl })
    db.update(schema.postings).set({ applicationId: a.id }).where(eq(schema.postings.id, id)).run()

    await resolveAggregatorPostings()

    const p = posting(id)
    expect(p.url).toBe('https://jobs.ashbyhq.com/jobber/a2')
    expect(p.applyUrl).toBe('https://jobs.ashbyhq.com/jobber/a2/application')
    expect(p.viaUrl).toBe('https://jobicy.com/jobs/153621-director')
    expect(p.jd).toContain('Full JD two')
    expect(p.compText).toBe('$200K – $250K')
    expect(p.key).toBe('ashby:jobber:a2')
    const src = db.select().from(schema.sources).where(eq(schema.sources.id, p.sourceId!)).get()!
    expect(src).toMatchObject({ kind: 'ashby', board: 'jobber', status: 'candidate' })
    expect(getApplication(a.id)).toMatchObject({ jobUrl: 'https://jobs.ashbyhq.com/jobber/a2', applyUrl: 'https://jobs.ashbyhq.com/jobber/a2/application' })
  })

  test('a listing we already have from the company board is marked a duplicate', async () => {
    db.insert(schema.postings)
      .values({ id: 'job_direct', key: 'ashby:jobber:a1', sourceId: null, companyName: 'Jobber', title: BOARD[0]!.title, url: BOARD[0]!.url, firstSeenAt: nowIso(), lastSeenAt: nowIso(), triageStatus: 'done', decision: 'maybe' })
      .run()
    const id = listing(BOARD[0]!.title, '153620-director')
    await resolveAggregatorPostings()
    // It leaves the feed, but carries the real links in case the user opens or tracks it from elsewhere.
    expect(posting(id)).toMatchObject({ triageStatus: 'skipped', heuristic: 'duplicate of job_direct', url: BOARD[0]!.url, viaUrl: 'https://jobicy.com/jobs/153620-director', key: 'rss:jobicy:153620-director' })
  })

  test('an already-triaged duplicate leaves the feed too, so the user tracks the company copy', async () => {
    db.insert(schema.postings)
      .values({ id: 'job_direct4', key: 'ashby:jobber:a4', sourceId: null, companyName: 'Jobber', title: BOARD[3]!.title, url: BOARD[3]!.url, firstSeenAt: nowIso(), lastSeenAt: nowIso(), triageStatus: 'done', decision: 'maybe' })
      .run()
    const id = listing(BOARD[3]!.title, '153699-sem', { triageStatus: 'done', decision: 'maybe' })
    await resolveAggregatorPostings()
    expect(posting(id)).toMatchObject({ triageStatus: 'skipped', url: BOARD[3]!.url, applyUrl: BOARD[3]!.applyUrl })
  })

  test('an unknown company is tried once, then left alone', async () => {
    const id = listing('Staff Engineer', 'nowhere', { companyName: 'Nowhere Co' })
    await resolveAggregatorPostings()
    expect(posting(id).resolvedAt).toBeTruthy()
    expect(posting(id).url).toBe('https://jobicy.com/jobs/nowhere')
    const co = db.select().from(schema.companies).where(eq(schema.companies.name, 'Nowhere Co')).get()!
    expect(co.atsCheckedAt).toBeTruthy()
    expect(co.atsKind).toBeNull()
  })
})

describe('location survives the aggregator', () => {
  // A user in the US, as onboarding sets them up: location filters generated from their country.
  beforeAll(() => {
    updateSettings('you', { country: 'US' })
    updateSettings('scout', buildLocationFilters('US', []))
  })
  test("Jobicy's feed location and company are read, not flattened to Remote", () => {
    const [it] = parseRss(`<rss><channel><item><title>Senior Engineering Manager</title><link>https://jobicy.com/jobs/156779-senior-engineering-manager</link>
      <job_listing:location><![CDATA[Europe]]></job_listing:location><job_listing:company><![CDATA[Synthesia]]></job_listing:company><description>JD</description></item></channel></rss>`)
    expect(it).toMatchObject({ region: 'Europe', company: 'Synthesia' })
  })

  test('a pending listing whose company posting is outside the US is filtered before triage', async () => {
    const id = listing('Manager, Software Engineering, Operations', '160001-manager', { location: 'Remote' })
    await resolveAggregatorPostings()
    expect(posting(id)).toMatchObject({ location: 'Toronto', triageStatus: 'skipped', heuristic: 'fail: location' })
  })

  test('a tracked listing is flagged and its application picks up the real location', async () => {
    const id = listing('Senior Engineering Manager, Platform', '160002-sem', { location: 'Remote', triageStatus: 'done', decision: 'queue' })
    const a = createApplication({ companyName: 'Jobber', role: 'Senior Engineering Manager', jobUrl: posting(id).url, applyUrl: posting(id).applyUrl, location: 'Remote' })
    db.update(schema.postings).set({ applicationId: a.id }).where(eq(schema.postings.id, id)).run()
    await resolveAggregatorPostings()
    expect(posting(id)).toMatchObject({ location: 'Europe | Remote', locationFit: 'no', triageStatus: 'done' })
    expect(posting(id).locationNote).toContain('Europe · Remote')
    expect(getApplication(a.id)?.location).toBe('Europe | Remote')
  })

  test('rescanning the aggregator does not bring a resolved listing back as new', async () => {
    const url = 'https://jobicy.com/jobs/160002-sem'
    FEED = [{ extId: url, title: 'Senior Engineering Manager, Platform', location: 'Remote', url, applyUrl: url, jd: 'Short teaser…' }]
    const before = db.select().from(schema.postings).all().length
    const r = await Effect.runPromise(scan({ sourceIds: [jobicy] }))
    expect(r).toMatchObject({ sources: 1, errors: 0, new: 0 })
    expect(db.select().from(schema.postings).all().length).toBe(before)
  })
})
