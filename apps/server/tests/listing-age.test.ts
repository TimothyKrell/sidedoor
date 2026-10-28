import { describe, expect, test } from 'vitest'
import { db, schema } from '../src/db/client'
import { newId, toIsoDate } from '../src/ids'
import { listPostings } from '../src/queries'

const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000)
const listing = (title: string, o: { postedAt?: string | null; firstSeenAt: string }) =>
  db.insert(schema.postings)
    .values({ id: newId('job_'), key: newId('k_'), title, companyName: 'Acme', firstSeenAt: o.firstSeenAt, lastSeenAt: o.firstSeenAt, postedAt: o.postedAt ?? null, decision: 'queue', fitScore: 80 })
    .run()

describe('listing age', () => {
  test('board dates are stored as ISO; bare dates and junk are handled', () => {
    expect(toIsoDate('Fri, 23 Oct 2026 23:38:33 GMT')).toBe('2026-10-23T23:38:33.000Z')
    expect(toIsoDate('2026-09-21')).toBe('2026-09-21')
    expect(toIsoDate('2026-10-19T11:17:24-04:00')).toBe('2026-10-19T11:17:24-04:00')
    expect(toIsoDate('not a date')).toBeNull()
    expect(toIsoDate(undefined)).toBeNull()
  })

  test('the Jobs list goes by posted date, falling back to first seen', () => {
    // Found today on a newly added board, but posted three weeks ago.
    listing('Old posting, new board', { postedAt: daysAgo(21).toISOString(), firstSeenAt: new Date().toISOString() })
    // Posted two days ago; first-seen written with a local offset, like the scanner does.
    listing('Posted two days ago', { postedAt: toIsoDate(daysAgo(2).toUTCString()), firstSeenAt: daysAgo(1).toISOString().replace('Z', '+00:00') })
    // No posted date: counts from when we found it.
    listing('Undated, seen yesterday', { firstSeenAt: daysAgo(1).toISOString() })

    expect(listPostings({ window: '7d' }).map((p) => p.title)).toEqual(['Undated, seen yesterday', 'Posted two days ago'])
    expect(listPostings({ window: '30d' }).map((p) => p.title)).toEqual(['Undated, seen yesterday', 'Posted two days ago', 'Old posting, new board'])
  })
})
