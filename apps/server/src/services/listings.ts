import { eq } from 'drizzle-orm'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { nowIso } from '../ids'
import type { ListingCheck } from '../scout/listing'
import { type AppPatch, getApplication } from './applications'

/**
 * What a listing check means for an application: its posted date and whether the listing is up.
 * These commands write only those fields (and the same two on its posting), never its stage,
 * notes or activity time, so checking every application changes nothing else. Acting on a closed
 * listing is `reconcile`'s job (jobs/runner.ts), as it is when the scout sees a listing go.
 */

/** Ambiguous misses in a row that close a listing. A clear signal closes it at once. */
export const MISSES_TO_CLOSE = 2

type Listing = Pick<schema.Application, 'postedAt' | 'postedAtSource' | 'postedAtExact' | 'listingStatus' | 'listingMisses' | 'listingClosedAt'>

/** How much to trust a date: the ATS's own exact date, then a page's JSON-LD, then estimates and list dates. */
const dateRank = (source: string | null | undefined, exact: boolean | null | undefined) => {
  if (!source) return 0
  if (!exact) return 1
  return source.startsWith('json-ld') || source.startsWith('scout') ? 2 : 3
}

/** The posted-date fields a check should set, if it knows better than what's there. */
export const nextPostedAt = (a: Listing, c: Pick<ListingCheck, 'postedAt' | 'postedAtSource' | 'postedAtExact'>): AppPatch => {
  if (!c.postedAt || !c.postedAtSource) return {}
  const better = dateRank(c.postedAtSource, c.postedAtExact) > dateRank(a.postedAtSource, a.postedAtExact)
  const refresh = c.postedAtSource === a.postedAtSource && c.postedAt !== a.postedAt
  if (a.postedAt && !better && !refresh) return {}
  return { postedAt: c.postedAt, postedAtSource: c.postedAtSource, postedAtExact: c.postedAtExact ?? false }
}

/** The liveness fields after a check: a clear signal or two misses in a row close it; open resets the count. */
export const nextListing = (a: Listing, c: Pick<ListingCheck, 'verdict' | 'via' | 'evidence'>, at: string): AppPatch => {
  const evidence = `${c.via}: ${c.evidence}`.slice(0, 500)
  const base = { listingCheckedAt: at, listingEvidence: evidence }
  switch (c.verdict) {
    case 'open':
      return { ...base, listingStatus: 'open', listingMisses: 0, listingClosedAt: null }
    case 'closed':
      return { ...base, listingStatus: 'closed', listingMisses: a.listingMisses + 1, listingClosedAt: a.listingClosedAt ?? at }
    case 'missing': {
      const misses = a.listingMisses + 1
      if (misses >= MISSES_TO_CLOSE || a.listingStatus === 'closed') return { ...base, listingStatus: 'closed', listingMisses: misses, listingClosedAt: a.listingClosedAt ?? at }
      return { ...base, listingEvidence: `${evidence} (${misses} of ${MISSES_TO_CLOSE} misses before it counts as closed)`.slice(0, 500), listingStatus: 'suspect', listingMisses: misses }
    }
    default:
      // Couldn't tell: keep what we knew, and the miss count (an outage between two misses isn't a third).
      return { ...base, listingStatus: a.listingStatus ?? 'unknown' }
  }
}

/**
 * When the listing behind an application closed, or null while it's up. The application's own
 * check decides, unless the scout saw its posting go since.
 */
export const listingClosedAt = (a: Pick<schema.Application, 'listingStatus' | 'listingClosedAt' | 'listingCheckedAt'>, posting?: { closedAt: string | null } | null) => {
  if (a.listingStatus === 'closed') return a.listingClosedAt
  const p = posting?.closedAt
  return p && (!a.listingCheckedAt || p > a.listingCheckedAt) ? p : null
}

const setListing = (id: string, patch: AppPatch) => {
  if (Object.keys(patch).length) db.update(schema.applications).set(patch).where(eq(schema.applications.id, id)).run()
}

/** Keep the posting in step: its date when it has none, and closed or open as the check found. */
const syncPosting = (postingId: string | null, patch: AppPatch) => {
  if (!postingId) return
  const p = db.select({ postedAt: schema.postings.postedAt, closedAt: schema.postings.closedAt }).from(schema.postings).where(eq(schema.postings.id, postingId)).get()
  if (!p) return
  const set: Partial<schema.Posting> = {}
  if (!p.postedAt && patch.postedAt) set.postedAt = patch.postedAt
  if (patch.listingStatus === 'closed' && !p.closedAt) set.closedAt = patch.listingClosedAt ?? nowIso()
  if (patch.listingStatus === 'open' && p.closedAt) set.closedAt = null
  if (Object.keys(set).length) db.update(schema.postings).set(set).where(eq(schema.postings.id, postingId)).run()
}

/** Record one listing check on an application (and its posting). */
export const recordListingCheck = atomic((id: string, check: ListingCheck, o: { at?: string } = {}) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const at = o.at ?? nowIso()
  const patch: AppPatch = { ...nextPostedAt(a, check), ...nextListing(a, check, at) }
  setListing(id, patch)
  syncPosting(a.postingId, patch)
  if (a.listingStatus === 'closed' && patch.listingStatus === 'open')
    logActivity('application', `${a.companyName} – ${a.role}: the listing is up after all`, { detail: patch.listingEvidence ?? undefined, link: `/applications/${id}` })
  return getApplication(id)!
})

/** A posted date from somewhere other than a check (the scout's board list), kept only if it beats what's there. */
export const recordPostedAt = atomic((id: string, d: { postedAt: string; postedAtSource: string; postedAtExact: boolean }) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  setListing(id, nextPostedAt(a, d))
  return getApplication(id)!
})

/** You looked: the listing is still up. */
export const markListingOpen = atomic((id: string) => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const patch = nextListing(a, { verdict: 'open', via: 'you', evidence: 'You checked: still open' }, nowIso())
  setListing(id, patch)
  syncPosting(a.postingId, patch)
  return getApplication(id)!
})
