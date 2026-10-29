import { getMeta, setMeta } from '../settings'

/**
 * Subscription usage limits. When the user's AI says it's out of usage ("You've hit your session
 * limit · resets 10:10pm (America/New_York)"), every job would fail the same way until it resets,
 * so work waits for the reset instead of failing.
 */
const LIMIT = /hit your (session|usage|weekly|daily|monthly) limit|usage limit (reached|exceeded)|out of (usage|credits)|rate[- ]limit(ed)?\b.*(reset|try again)/i

/** When the limit lifts, from the message's "resets 10:10pm (Area/City)", else in 30 minutes. */
export const usageLimitUntil = (message: string, now = new Date()): Date | null => {
  if (!LIMIT.test(message)) return null
  const fallback = new Date(now.getTime() + 30 * 60_000)
  const m = message.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?/i)
  if (!m) return fallback
  const hour = (Number(m[1]) % 12) + (m[3]!.toLowerCase() === 'pm' ? 12 : 0)
  const minute = Number(m[2] ?? 0)
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: m[4], hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(now)
  } catch {
    return fallback
  }
  const part = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0)
  // Minutes from the wall clock there to the reset; a time already past means tomorrow's.
  let ahead = hour * 60 + minute - (part('hour') * 60 + part('minute'))
  if (ahead <= 0) ahead += 24 * 60
  // A minute's slack, so the first job after the reset doesn't land just before it.
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000 + (ahead + 1) * 60_000)
}

/** The time AI work is paused until, if a usage limit is in effect. */
export const aiLimitedUntil = () => {
  const until = getMeta<string>('aiLimitedUntil')
  return until && new Date(until).getTime() > Date.now() ? until : null
}

export const setAiLimitedUntil = (until: Date) => {
  const current = aiLimitedUntil()
  if (!current || new Date(current).getTime() < until.getTime()) setMeta('aiLimitedUntil', until.toISOString())
}
