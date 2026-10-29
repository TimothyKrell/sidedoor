import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { db, schema } from '../src/db/client'
import { nowIso } from '../src/ids'
import type { RawJob } from '../src/scout/adapters'
import { buildTitleFilters, roleRegex } from '../src/scout/filters'
import { activateFoundBoards } from '../src/scout/resolve'
import { compileFilters, dueSources, heuristic, scan } from '../src/scout/scan'
import { getSettings, updateSettings } from '../src/settings'

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString()

/** What each mocked board lists on the next scan. */
const BOARDS: Record<string, RawJob[]> = {}
const detailCalls: string[] = []

vi.mock('../src/scout/adapters', async (orig) => {
  const real = await orig<typeof import('../src/scout/adapters')>()
  const list = (board: string) => Effect.succeed((BOARDS[board] ?? []).map((j) => ({ ...j })))
  return {
    ...real,
    ADAPTERS: { ...real.ADAPTERS, greenhouse: list, rss: list, workday: list },
    DETAILS: {
      workday: (_board: string, job: RawJob) => {
        detailCalls.push(job.extId)
        return job.extId === 'broken'
          ? Effect.fail(new real.FetchError(job.url ?? '', 500, 'HTTP 500'))
          : Effect.succeed({ jd: `Full description of ${job.title}`, location: job.extId === 'abroad' ? 'London, United Kingdom' : 'Remote, United States' })
      },
    },
  }
})

const source = (id: string, kind: string, board: string, o: Partial<typeof schema.sources.$inferInsert> = {}) => {
  db.insert(schema.sources).values({ id, name: board, kind, board, status: 'active', ...o }).run()
  return id
}
const posting = (key: string) => db.select().from(schema.postings).where(eq(schema.postings.key, key)).get()
const job = (extId: string, title: string, o: Partial<RawJob> = {}): RawJob => ({ extId, title, location: 'Remote', url: `https://x.test/${extId}`, jd: `JD for ${title}`, ...o })

beforeEach(() => {
  updateSettings('scout', { titleInclude: ['engineering manager'], titleExclude: [], locationOk: 'united states', remoteWords: 'remote', locationBlock: 'united kingdom|london', maxAgeDays: 30, boardMaxAgeDays: 180 })
})

describe('age limits', () => {
  test('company boards get the longer limit; feeds the shorter', () => {
    const f = compileFilters(getSettings().scout)
    const old = { title: 'Engineering Manager', location: 'Remote', postedAt: daysAgo(60) }
    expect(heuristic(old, f)).toBe('fail: old')
    expect(heuristic(old, f, f.boardMaxAgeDays)).toBe('pass')
    expect(heuristic({ ...old, postedAt: daysAgo(200) }, f, f.boardMaxAgeDays)).toBe('fail: old')
    expect(heuristic({ ...old, postedAt: daysAgo(900) }, f, 0)).toBe('pass')
  })

  test('a two-month-old posting still listed on a company board is scored; the same on a feed is not', async () => {
    const board = source('src_board', 'greenhouse', 'acme')
    const feed = source('src_feed', 'rss', 'https://feed.test/rss')
    BOARDS.acme = [job('old1', 'Engineering Manager, Payments', { postedAt: daysAgo(60) })]
    BOARDS['https://feed.test/rss'] = [job('old2', 'Engineering Manager, Growth', { postedAt: daysAgo(60) })]
    await Effect.runPromise(scan({ sourceIds: [board, feed] }))
    expect(posting('greenhouse:acme:old1')).toMatchObject({ heuristic: 'pass', triageStatus: 'pending' })
    expect(posting('rss:https://feed.test/rss:old2')).toMatchObject({ heuristic: 'fail: old', triageStatus: 'skipped', jd: null })
  })
})

describe('changing the filters', () => {
  test('postings they dropped get another look on the next scan, with their description', async () => {
    const id = source('src_refilter', 'greenhouse', 'refilter')
    BOARDS.refilter = [job('r1', 'Director of Engineering'), job('r2', 'Account Executive'), job('r3', 'Director, Platform Engineering')]
    await Effect.runPromise(scan({ sourceIds: [id] }))
    expect(posting('greenhouse:refilter:r1')).toMatchObject({ heuristic: 'fail: title', triageStatus: 'skipped', jd: null })
    // The user dismissed this one; it stays dismissed.
    db.update(schema.postings).set({ userStatus: 'dismissed' }).where(eq(schema.postings.key, 'greenhouse:refilter:r3')).run()

    updateSettings('scout', { titleInclude: ['engineering manager', 'director.{0,30}engineering'] })
    const r = await Effect.runPromise(scan({ sourceIds: [id] }))
    expect(r).toMatchObject({ new: 0, revived: 1 })
    expect(posting('greenhouse:refilter:r1')).toMatchObject({ heuristic: 'pass', triageStatus: 'pending', jd: 'JD for Director of Engineering' })
    expect(posting('greenhouse:refilter:r2')).toMatchObject({ heuristic: 'fail: title', triageStatus: 'skipped' })
    expect(posting('greenhouse:refilter:r3')).toMatchObject({ triageStatus: 'skipped', userStatus: 'dismissed' })
  })

  test('a posting already scored is left alone', async () => {
    const id = source('src_scored', 'greenhouse', 'scored')
    BOARDS.scored = [job('s1', 'Engineering Manager')]
    await Effect.runPromise(scan({ sourceIds: [id] }))
    db.update(schema.postings).set({ triageStatus: 'done', decision: 'skip', fitScore: 30 }).where(eq(schema.postings.key, 'greenhouse:scored:s1')).run()
    await Effect.runPromise(scan({ sourceIds: [id] }))
    expect(posting('greenhouse:scored:s1')).toMatchObject({ triageStatus: 'done', decision: 'skip' })
  })
})

describe('boards that list no descriptions', () => {
  test('the description is read for postings that pass, and the full posting is filtered again', async () => {
    const id = source('src_wd', 'workday', 'acme.wd5/jobs')
    BOARDS['acme.wd5/jobs'] = [
      job('em', 'Engineering Manager, Checkout', { jd: '', location: '' }),
      job('abroad', 'Engineering Manager, EMEA', { jd: '', location: '' }),
      job('broken', 'Senior Engineering Manager', { jd: '', location: '' }),
      job('sales', 'Account Executive', { jd: '', location: '' }),
    ]
    detailCalls.length = 0
    await Effect.runPromise(scan({ sourceIds: [id] }))
    expect(detailCalls.sort()).toEqual(['abroad', 'broken', 'em'])
    expect(posting('workday:acme.wd5/jobs:em')).toMatchObject({ triageStatus: 'pending', jd: 'Full description of Engineering Manager, Checkout', location: 'Remote, United States' })
    expect(posting('workday:acme.wd5/jobs:abroad')).toMatchObject({ triageStatus: 'skipped', heuristic: 'fail: location', location: 'London, United Kingdom' })
    // A failed read doesn't lose the posting.
    expect(posting('workday:acme.wd5/jobs:broken')).toMatchObject({ triageStatus: 'pending', jd: '' })
    expect(posting('workday:acme.wd5/jobs:sales')).toMatchObject({ triageStatus: 'skipped', heuristic: 'fail: title' })
  })

  test('Workday is polled at most hourly, whatever the interval setting', () => {
    db.update(schema.sources).set({ lastCheckedAt: daysAgo(30 / 1440) }).run()
    const due = dueSources({ ...getSettings().scout, normalIntervalMin: 15 }).map((s) => s.kind)
    expect(due).toContain('greenhouse')
    expect(due).not.toContain('workday')
    expect(dueSources(getSettings().scout, true).map((s) => s.kind)).not.toContain('workday')
  })
})

describe('boards found through job feeds', () => {
  test('waiting ones are switched on once; what the user sets afterwards stands', () => {
    source('src_found', 'ashby', 'found', { status: 'candidate', origin: 'aggregator' })
    source('src_manual', 'manual', 'https://acme.test/careers', { status: 'candidate', origin: 'aggregator' })
    source('src_seed', 'greenhouse', 'seed', { status: 'candidate', origin: 'seed' })
    expect(activateFoundBoards()).toBe(1)
    const status = (id: string) => db.select().from(schema.sources).where(eq(schema.sources.id, id)).get()!.status
    expect([status('src_found'), status('src_manual'), status('src_seed')]).toEqual(['active', 'candidate', 'candidate'])
    db.update(schema.sources).set({ status: 'candidate', lastCheckedAt: nowIso() }).where(eq(schema.sources.id, 'src_found')).run()
    expect(activateFoundBoards()).toBe(0)
    expect(status('src_found')).toBe('candidate')
  })
})

describe('generated title filters', () => {
  test('two-word roles match either order', () => {
    const re = new RegExp(roleRegex('Engineering Manager')!, 'i')
    expect(re.test('Senior Engineering Manager, Payments')).toBe(true)
    expect(re.test('Manager, Software Engineering')).toBe(true)
    expect(re.test('Product Manager')).toBe(false)
  })
  test('junior roles are left out for senior searches', () => {
    const { titleExclude } = buildTitleFilters(['Software Engineer'], ['Senior'])
    expect(new RegExp(titleExclude[0]!, 'i').test('Software Engineer, Early Career')).toBe(true)
  })
})
