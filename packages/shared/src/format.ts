export const STAGES = ['interested', 'review', 'approved', 'applied', 'screening', 'interviewing', 'offer', 'closed'] as const
export type Stage = (typeof STAGES)[number]

export const STAGE_META: Record<Stage, { label: string; short: string; tone: string }> = {
  interested: { label: 'Interested', short: 'Interested', tone: 'bg-muted text-muted-foreground' },
  review: { label: 'Ready for review', short: 'Review', tone: 'bg-primary/15 text-primary' },
  approved: { label: 'Approved · submit', short: 'Submit', tone: 'bg-hot/15 text-hot' },
  applied: { label: 'Applied', short: 'Applied', tone: 'bg-success/15 text-success' },
  screening: { label: 'Screening', short: 'Screen', tone: 'bg-chart-3/15 text-chart-3' },
  interviewing: { label: 'Interviewing', short: 'Interview', tone: 'bg-chart-4/15 text-chart-4' },
  offer: { label: 'Offer', short: 'Offer', tone: 'bg-success/25 text-success' },
  closed: { label: 'Closed', short: 'Closed', tone: 'bg-muted text-muted-foreground/70' },
}

export const PERSON_KIND_LABEL: Record<string, string> = {
  recruiter: 'Recruiter',
  'hiring-manager': 'Hiring manager',
  founder: 'Founder',
  referral: 'Referral',
  network: 'Network',
  interviewer: 'Interviewer',
  other: 'Contact',
}

export const RELATIONSHIP_LABEL: Record<string, string> = {
  'not-contacted': 'Not contacted',
  contacted: 'Contacted',
  replied: 'Replied',
  engaged: 'Engaged',
  dormant: 'Dormant',
}

export const timeAgo = (iso: string | null | undefined, now = Date.now()) => {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const s = Math.round((now - t) / 1000)
  if (s < 0) return 'soon'
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d < 60) return `${d}d ago`
  return `${Math.round(d / 30)}mo ago`
}

/** Age in hours of a posting (posted date when known, else when we first saw it). */
export const ageHours = (postedAt: string | null | undefined, firstSeenAt: string) => {
  const ts = new Date(postedAt ?? firstSeenAt).getTime()
  return Number.isNaN(ts) ? null : (Date.now() - ts) / 3600_000
}

const localDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const todayStr = () => localDay(new Date())
export const plusDays = (n: number) => {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return localDay(d)
}

/** "today", "tomorrow", "in 3d", "2d overdue" for YYYY-MM-DD dates. */
export const dueLabel = (date: string | null | undefined) => {
  if (!date) return null
  const d = Math.round((new Date(`${date.slice(0, 10)}T12:00:00`).getTime() - new Date(`${todayStr()}T12:00:00`).getTime()) / 86400_000)
  if (d === 0) return { text: 'Due today', overdue: false, soon: true }
  if (d === 1) return { text: 'Due tomorrow', overdue: false, soon: true }
  if (d < 0) return { text: `${-d}d overdue`, overdue: true, soon: true }
  return { text: d < 14 ? `Due in ${d}d` : `Due ${new Date(`${date.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`, overdue: false, soon: d <= 2 }
}

export const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso.length === 10 ? `${iso}T12:00:00` : iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(iso).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' }) : '—'

export const fitTone = (fit: number | null | undefined) =>
  fit == null ? 'bg-muted text-muted-foreground' : fit >= 85 ? 'bg-success/20 text-success' : fit >= 70 ? 'bg-primary/20 text-primary' : fit >= 55 ? 'bg-info/15 text-info' : 'bg-muted text-muted-foreground'

const CUR = String.raw`(?:[A-Z]{0,3}[$€£¥₩₹]|[A-Z]{3}\s)`
const AMT = String.raw`(\d[\d,]*(?:\.\d+)?)\s?([kKmML](?![a-z]))?`
const MONEY = new RegExp(String.raw`(${CUR})\s?${AMT}(?:\s*(?:-|–|—|to)\s*${CUR}?\s?${AMT})?`)
const SYMBOL: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' }
const money = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${+n.toFixed(2)}`)
const scale = (digits: string, suffix: string | undefined) => Number(digits.replace(/,/g, '')) * ({ k: 1e3, K: 1e3, m: 1e6, M: 1e6, L: 1e5 }[suffix ?? ''] ?? 1)
const range = (cur: string, lo: number, hi: number | null, unit = '') =>
  !lo && !hi ? null : !lo ? `up to ${cur}${money(hi!)}${unit}` : hi && hi !== lo ? `${cur}${money(lo)}–${cur.endsWith(' ') ? '' : cur}${money(hi)}${unit}` : `${cur}${money(lo)}${unit}`

/** Short salary range for cards, e.g. "$215K–$250K". Reads the first range in the board's text (its min/max are sometimes wrong), else min/max. */
export const salaryRange = (text: string | null | undefined, min?: number | null, max?: number | null): string | null => {
  const t = text?.trim() ?? ''
  if (t.startsWith('{')) {
    // Some boards' salary objects are stored as JSON: {"min", "max", "currency", "interval"}.
    try {
      const j = JSON.parse(t) as { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown }
      const code = typeof j.currency === 'string' ? j.currency : 'USD'
      const unit = typeof j.interval === 'string' ? (/hour/.test(j.interval) ? '/hr' : /month/.test(j.interval) ? '/mo' : '') : ''
      return range(SYMBOL[code] ?? `${code} `, Number(j.min) || 0, Number(j.max) || null, unit)
    } catch {
      return null
    }
  }
  const m = MONEY.exec(t)
  if (m) {
    const [, rawCur = '$', d1 = '', s1, d2, s2] = m
    const code = rawCur.trim()
    const cur = SYMBOL[code] ?? (/^[A-Z]{3}$/.test(code) ? `${code} ` : code)
    let lo = scale(d1, s1)
    const hi = d2 ? scale(d2, s2) : null
    if (hi !== null && !s1 && s2 && lo < 1000) lo = scale(d1, s2) // "$150-200K"
    const hourly = /^\s*(\/\s*h|per hour|an hour|hourly)/i.test(t.slice(m.index + m[0].length)) ? '/hr' : ''
    return range(cur, lo, hi, hourly)
  }
  return min || max ? range('$', min ?? 0, max ?? null) : null
}
