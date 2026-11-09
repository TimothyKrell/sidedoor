/**
 * Which job to work on first: how new the listing is, how well it fits, and what it pays, as one
 * 0-100 score. Newness counts most, since applying in the first days puts you ahead of the pile;
 * fit and pay count the same. Each part is 0-100 and a missing one gets a middling-low value, so a
 * job isn't buried for an unpublished salary but doesn't beat one that shows a good one.
 */

export const QUEUE_WEIGHTS = { fresh: 0.5, fit: 0.25, pay: 0.25 } as const
/** Days for a listing's newness to halve: a day old ~84, three ~59, a week ~30, two weeks ~9. */
const HALF_LIFE_DAYS = 4

export interface QueueInput {
  postedAt?: string | null
  fitScore?: number | null
  compMin?: number | null
  compMax?: number | null
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

export const queueParts = (j: QueueInput, o: { salaryMin?: number | null; now?: number } = {}) => {
  const now = o.now ?? Date.now()
  const posted = j.postedAt ? Date.parse(j.postedAt) : Number.NaN
  const ageDays = Number.isNaN(posted) ? null : Math.max(0, (now - posted) / 86400_000)
  const fresh = ageDays === null ? 25 : clamp(100 * 0.5 ** (ageDays / HALF_LIFE_DAYS))
  // Fit 55 and under is 0, 95 and over is 100.
  const fit = j.fitScore == null ? 30 : clamp(((j.fitScore - 55) / 40) * 100)
  // Pay against the user's minimum: three quarters of it is 0, half again over it is 100.
  const top = j.compMax ?? j.compMin
  const floor = o.salaryMin ?? 150_000
  const pay = !top ? 40 : clamp(((top - floor * 0.75) / (floor * 1.5 - floor * 0.75)) * 100)
  return { fresh: Math.round(fresh), fit: Math.round(fit), pay: Math.round(pay), ageDays }
}

export const queueScore = (j: QueueInput, o: { salaryMin?: number | null; now?: number } = {}) => {
  const p = queueParts(j, o)
  return Math.round(QUEUE_WEIGHTS.fresh * p.fresh + QUEUE_WEIGHTS.fit * p.fit + QUEUE_WEIGHTS.pay * p.pay)
}
