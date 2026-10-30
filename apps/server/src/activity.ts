import { and, eq } from 'drizzle-orm'
import { db, schema } from './db/client'
import { newId, nowIso } from './ids'
import type { InjectionFlag } from './untrusted'

export type ActivityKind =
  | 'scout'
  | 'triage'
  | 'prep'
  | 'research'
  | 'outreach'
  | 'followup'
  | 'application'
  | 'person'
  | 'funding'
  | 'discover'
  | 'system'
  | 'chat'
  | 'guard'

/** Append to the human-readable feed on the Today page. */
export const logActivity = (kind: ActivityKind, title: string, opts: { detail?: string; link?: string } = {}) =>
  db.insert(schema.activity)
    .values({ id: newId('act_'), kind, title, detail: opts.detail ?? null, link: opts.link ?? null, at: nowIso() })
    .run()

/**
 * Record what the prompt guard found in a posting, once per posting and finding: what matched and
 * what was done about it. `link` is the application (or the posting, before there is one).
 */
export const logInjection = (flags: InjectionFlag[], opts: { subject: string; link: string; where: string }) => {
  const found = flags.filter((f) => f.kind !== 'invisible' || flags.length === 1)
  if (!found.length) return
  const detail = found.map((f) => `${f.kind}: "${f.text}" (${f.action})`).join('\n')
  const seen = db.select({ id: schema.activity.id }).from(schema.activity)
    .where(and(eq(schema.activity.kind, 'guard'), eq(schema.activity.link, opts.link), eq(schema.activity.detail, detail))).get()
  if (seen) return
  console.warn(`[guard] ${opts.subject} (${opts.where}): ${detail}`)
  logActivity('guard', `${opts.subject}: posting has ${found.length} piece(s) of text aimed at AI tools, fenced as data for ${opts.where}`, { detail, link: opts.link })
}
