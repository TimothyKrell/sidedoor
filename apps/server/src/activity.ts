import { db, schema } from './db/client'
import { newId, nowIso } from './ids'

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

/** Append to the human-readable feed on the Today page. */
export const logActivity = (kind: ActivityKind, title: string, opts: { detail?: string; link?: string } = {}) =>
  db.insert(schema.activity)
    .values({ id: newId('act_'), kind, title, detail: opts.detail ?? null, link: opts.link ?? null, at: nowIso() })
    .run()
