import { desc, eq } from 'drizzle-orm'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { paths } from './config'
import { db, schema } from './db/client'
import { today } from './ids'
import { docBody, isWritten } from './services/documents'
import { getSettings } from './settings'

const cache = new Map<string, string>()
export const template = (name: string) => {
  // Prompts ship with the app; read once per process (dev restarts on change).
  let t = cache.get(name)
  if (t === undefined) {
    const p = resolve(paths.prompts, `${name}.md`)
    t = existsSync(p) ? readFileSync(p, 'utf8') : ''
    cache.set(name, t)
  }
  return t
}

export const userName = () => getSettings().you.name.trim() || 'the user'
export const firstName = () => userName().split(/\s+/)[0] ?? userName()

/** Fill a prompt template. {{TODAY}}, {{NAME}}, {{FIRST_NAME}} are always available. */
export const render = (name: string, vars: Record<string, string | number | null | undefined> = {}) => {
  let t = template(name)
  const all = { TODAY: today(), NAME: userName(), FIRST_NAME: firstName(), ...vars }
  for (const [k, v] of Object.entries(all)) t = t.replaceAll(`{{${k}}}`, v == null ? '' : String(v))
  return t
}

const list = (xs: string[]) => (xs.length ? xs.join(', ') : 'not specified')

/** The user's search: structured choices first, then their own words. */
const criteria = () => {
  const s = getSettings()
  const q = s.search
  const you = s.you
  const written = isWritten('search')
  // With the user's own description, leave out choices they never made.
  const opt = (label: string, xs: string[]) => (xs.length || !written ? `${label}: ${list(xs)}` : null)
  const lines = [
    opt('Target roles', q.roles),
    q.seniority.length ? `Seniority: ${list(q.seniority)}` : null,
    opt('Work arrangement', q.workModes),
    `Lives in: ${[you.location, you.country].filter(Boolean).join(', ') || 'not specified'}`,
    opt('Can work in / commute to', q.locations),
    q.salaryMin ? `Minimum base salary: ${q.salaryMin.toLocaleString('en-US')} ${q.currency}` : null,
    q.lanes.length ? `Industries / lanes: ${list(q.lanes)}` : null,
    q.dealbreakers.length ? `Dealbreakers: ${list(q.dealbreakers)}` : null,
  ].filter(Boolean)
  const doc = written ? `\n\nIn their words:\n${docBody('search')}` : ''
  return `${lines.join('\n')}${doc}`
}

const voiceSample = () => {
  const sent = db
    .select({ body: schema.drafts.body })
    .from(schema.drafts)
    .where(eq(schema.drafts.status, 'sent'))
    .orderBy(desc(schema.drafts.sentAt))
    .limit(2)
    .all()
  return sent.map((d) => d.body).join('\n\n---\n\n').slice(0, 2500) || '(no sent messages yet; follow the writing style)'
}

export const context = {
  criteria,
  /** Standard form answers plus contact details. */
  profile: () => {
    const y = getSettings().you
    const contact = [`Name: ${y.name}`, `Email: ${y.email}`, `Phone: ${y.phone}`, `Location: ${y.location}`, ...y.links.map((l) => `${l.label}: ${l.url}`)].join('\n')
    return `${contact}\n\n${docBody('answers')}`
  },
  inventory: () => docBody('experience'),
  stories: () => docBody('stories'),
  writing: () => docBody('writing'),
  voiceSample,
}
