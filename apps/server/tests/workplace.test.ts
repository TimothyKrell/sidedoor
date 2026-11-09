import { eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { db, schema } from '../src/db/client'
import { newId, nowIso } from '../src/ids'
import type { RawJob } from '../src/scout/adapters'
import { compileFilters, readyToScore, scan, SWEPT } from '../src/scout/scan'
import { foreignPlaces, placePasses, workplaceOf } from '../src/scout/workplace'
import { getSettings, updateSettings } from '../src/settings'

const BOARDS: Record<string, RawJob[]> = {}
vi.mock('../src/scout/adapters', async (orig) => {
  const real = await orig<typeof import('../src/scout/adapters')>()
  return { ...real, ADAPTERS: { ...real.ADAPTERS, ashby: (board: string) => Effect.succeed(BOARDS[board] ?? []) } }
})

const US_OK = 'united states|\\bus\\b|\\busa\\b|u\\.s\\.|americas|north america|new york|\\bnyc\\b|new jersey|anywhere|worldwide|global'
const BLOCK = '\\b(uk|united kingdom|london|europe|emea|canada|toronto|india)\\b'
const LONG = (s: string) => `${s} ${'We build tools for teams and care about craft. '.repeat(10)}`

beforeEach(() => {
  updateSettings('search', { workModes: ['remote'] })
  updateSettings('scout', { titleInclude: ['engineering manager'], titleExclude: [], locationOk: US_OK, remoteWords: 'remote|distributed', locationBlock: BLOCK, maxAgeDays: 30, boardMaxAgeDays: 180 })
})

describe('where a posting can be worked from', () => {
  const ok = new RegExp(US_OK, 'i')
  const f = { locationOk: ok, remote: /remote|distributed/i, block: new RegExp(BLOCK, 'i'), foreign: foreignPlaces(ok) }

  test('a remote job that names a country or region the user cannot work in is not remote for them', () => {
    expect(placePasses('Santiago, Chile | remote', f)).toBe(false)
    expect(placePasses('Remote, Latin America', f)).toBe(false)
    expect(placePasses('Canada | Distributed', f)).toBe(false)
  })

  test('each listed place is read on its own; a bare Remote passes', () => {
    expect(placePasses('Spain (Remote) | Canada (Remote) | USA (Remote)', f)).toBe(true)
    expect(placePasses('Remote', f)).toBe(true)
    expect(placePasses('Remote (PST)', f)).toBe(true)
    expect(placePasses('Albuquerque, New Mexico | Remote', f)).toBe(true)
    expect(placePasses('United States - Remote | Canada - Remote | Remote', f)).toBe(true)
  })

  test('countries the user can work in are never treated as foreign', () => {
    expect(foreignPlaces(ok)?.test('United States')).toBe(false)
    expect(foreignPlaces(ok)?.test('Peru')).toBe(true)
  })
})

describe('remote or not', () => {
  test('the listing says so', () => {
    expect(workplaceOf({ title: 'Engineering Manager', location: 'United States | Remote' })).toBe('remote')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'San Francisco | Hybrid' })).toBe('not remote')
    expect(workplaceOf({ title: 'Engineering Manager (Onsite)', location: 'New York' })).toBe('not remote')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'New York | Remote | OnSite' })).toBe('unclear')
  })

  test('the description decides when the listing names only a place', () => {
    expect(workplaceOf({ title: 'Engineering Manager', location: 'New York, NY', jd: LONG('This role is hybrid, 3 days a week in the office.') })).toBe('not remote')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'San Francisco, CA', jd: LONG('This role can be held from one of our US hubs or remotely in the United States.') })).toBe('remote')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'Dallas, TX', jd: LONG('You will lead the payments team.') })).toBe('not remote')
  })

  test('listed remote but asking for office days is left for scoring to judge', () => {
    expect(workplaceOf({ title: 'Engineering Manager', location: 'Remote', jd: LONG('You will be in our SF office 2 days a week.') })).toBe('unclear')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'Remote', jd: LONG('We run a hybrid cloud and hybrid search stack.') })).toBe('remote')
  })

  test('with no description yet it waits, unless none is coming', () => {
    expect(workplaceOf({ title: 'Engineering Manager', location: 'New York, NY' })).toBe('unclear')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'New York, NY' }, true)).toBe('not remote')
    expect(workplaceOf({ title: 'Engineering Manager', location: 'Remote' }, true)).toBe('remote')
  })

  test('only a remote-only search checks for it', () => {
    expect(compileFilters(getSettings().scout, ['remote']).remoteOnly).toBe(true)
    expect(compileFilters(getSettings().scout, ['remote', 'hybrid']).remoteOnly).toBe(false)
  })
})

describe('before scoring', () => {
  const source = (id: string, kind: string, board: string, o: Partial<typeof schema.sources.$inferInsert> = {}) => {
    db.insert(schema.sources).values({ id, name: board, kind, board, status: 'active', ...o }).onConflictDoNothing().run()
    return id
  }
  const waiting = (sourceId: string, title: string, o: Partial<typeof schema.postings.$inferInsert> = {}) => {
    const id = newId('job_')
    db.insert(schema.postings).values({ id, key: `${sourceId}:${id}`, sourceId, title, location: 'Remote', jd: LONG('Remote across the US.'), firstSeenAt: nowIso(), lastSeenAt: nowIso(), triageStatus: 'pending', heuristic: 'pass', ...o }).run()
    return id
  }
  const posting = (id: string) => db.select().from(schema.postings).where(eq(schema.postings.id, id)).get()!

  test('an aggregator listing waits until it is matched to its original; the original is scored', () => {
    const feed = source('src_feed_rs', 'getro', 'jobs.fund.test')
    const board = source('src_board_rs', 'ashby', 'acme')
    const copy = waiting(feed, 'Engineering Manager, Payments')
    const original = waiting(board, 'Engineering Manager, Payments')
    const matched = waiting(feed, 'Engineering Manager, Growth', { resolvedAt: nowIso() })
    const ids = readyToScore(100).map((p) => p.id)
    expect(ids).toContain(original)
    expect(ids).toContain(matched)
    expect(ids).not.toContain(copy)
  })

  test('waiting postings that fail the filters now are set aside without a scoring call', () => {
    const board = source('src_board_rs2', 'ashby', 'acme2')
    const hybrid = waiting(board, 'Engineering Manager, Data', { location: 'New York, NY', jd: LONG('Hybrid role, 3 days a week in the office.') })
    const abroad = waiting(board, 'Engineering Manager, Core', { location: 'Lima, Peru | Remote' })
    const silent = waiting(board, 'Engineering Manager, Web', { location: 'Austin, TX, USA', jd: null })
    const ids = readyToScore(100).map((p) => p.id)
    expect(ids).not.toContain(hybrid)
    expect(posting(hybrid)).toMatchObject({ triageStatus: 'skipped', heuristic: 'fail: not remote' })
    expect(posting(abroad)).toMatchObject({ triageStatus: 'skipped', heuristic: 'fail: location' })
    expect(posting(silent)).toMatchObject({ triageStatus: 'skipped', heuristic: 'fail: not remote' })
  })

  test('a company sweep lets through engineering titles the filters drop, and they stay through scoring', async () => {
    const board = source('src_sweep', 'ashby', 'sweepco', { lastCheckedAt: nowIso() })
    BOARDS.sweepco = [
      { extId: 's1', title: 'AI Lead - Product Engineering', location: 'United States | Remote', jd: LONG('Remote in the US.') },
      { extId: 's2', title: 'Head of Organic Growth', location: 'United States | Remote', jd: LONG('Remote in the US.') },
    ]
    await Effect.runPromise(scan({ sourceIds: [board] }))
    const key = (x: string) => db.select().from(schema.postings).where(eq(schema.postings.key, `ashby:sweepco:${x}`)).get()!
    expect(key('s1')).toMatchObject({ heuristic: 'fail: title', triageStatus: 'skipped' })
    await Effect.runPromise(scan({ sourceIds: [board], sweep: true }))
    expect(key('s1')).toMatchObject({ heuristic: SWEPT, triageStatus: 'pending', jd: expect.stringContaining('Remote in the US') })
    expect(key('s2')).toMatchObject({ heuristic: 'fail: title', triageStatus: 'skipped' })
    expect(readyToScore(100).map((p) => p.id)).toContain(key('s1').id)
  })
})

describe('outreach', () => {
  test('drafts come when asked: off by default', () => {
    expect(getSettings().outreach.auto).toBe(false)
  })
})
