import { randomBytes } from 'node:crypto'

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Short, sortable-enough ids: time prefix + random suffix. */
export const newId = (prefix = '') => {
  const time = Date.now().toString(36)
  const rand = Array.from(randomBytes(8), (b) => alphabet[b % 36]).join('')
  return `${prefix}${time}${rand}`
}

export const nowIso = () => new Date().toISOString()

/** A board's date as ISO, so SQLite date functions can read it (RSS feeds send "Fri, 23 Oct 2026 23:38:33 GMT"). Bare dates stay as they are. */
export const toIsoDate = (s: string | null | undefined) => {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}($|T)/.test(s)) return s
  const t = new Date(s).getTime()
  return Number.isNaN(t) ? null : new Date(t).toISOString()
}

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Local calendar date `days` after a timestamp or YYYY-MM-DD date. */
export const addDays = (iso: string, days: number) => {
  // A bare date parses as UTC midnight, which is the previous evening here.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso)
  d.setDate(d.getDate() + days)
  return localDate(d)
}

export const today = () => localDate(new Date())
