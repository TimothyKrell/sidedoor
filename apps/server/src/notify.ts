import { and, eq, gte } from 'drizzle-orm'
import { Duration, Effect, Schedule } from 'effect'
import { bridgeNotify, hasBridge } from './browser/bridge'
import { config } from './config'
import { db, schema } from './db/client'
import { publish } from './events'
import { newId, nowIso } from './ids'
import { getSecret } from './secrets'
import { getSettings } from './settings'

export type NotifyKind = 'hot-job' | 'package-ready' | 'research-ready' | 'followup' | 'digest' | 'funding' | 'agent' | 'test'

export interface Notice {
  kind: NotifyKind
  title: string
  body: string
  /** App path (e.g. /jobs/abc) or absolute URL opened when the notification is tapped. */
  path?: string
  /** ntfy priority 1-5. 4+ makes noise on the phone. */
  priority?: 1 | 2 | 3 | 4 | 5
  tags?: string[]
  actions?: Array<{ label: string; path: string }>
  /** Suppresses duplicates within 24h. */
  dedupeKey?: string
}

const inQuietHours = (start: number, end: number, hour = new Date().getHours()) =>
  start === end ? false : start < end ? hour >= start && hour < end : hour >= start || hour < end

const abs = (path: string) => (path.startsWith('http') ? path : `${(getSettings().app.publicUrl || config.localUrl).replace(/\/$/, '')}${path}`)

class NtfyError extends Error {}

/**
 * Tell the user: a native desktop notification (desktop app), an in-app toast for open pages, and a
 * phone push through ntfy if they set it up. Records every notice. Never throws.
 */
export const notify = (n: Notice) =>
  Effect.gen(function* () {
    const s = getSettings().notify
    if (n.dedupeKey) {
      const since = new Date(Date.now() - 24 * 3600_000).toISOString()
      const dup = db
        .select({ id: schema.notifications.id })
        .from(schema.notifications)
        .where(and(eq(schema.notifications.dedupeKey, n.dedupeKey), gte(schema.notifications.at, since)))
        .get()
      if (dup) return { skipped: true as const }
    }
    let priority = n.priority ?? 3
    // During quiet hours, deliver silently instead of dropping.
    if (inQuietHours(s.quietStart, s.quietEnd) && n.kind !== 'test') priority = Math.min(priority, 2) as 1 | 2
    publish({ type: 'notice', title: n.title, body: n.body, kind: n.kind, ...(n.path ? { path: n.path } : {}) })
    if (s.desktop && hasBridge()) yield* Effect.promise(() => bridgeNotify({ title: n.title, body: n.body, ...(n.path ? { url: n.path } : {}) }).catch((e: unknown) => console.error('[notify] desktop failed', e)))
    const token = getSecret('ntfy-token')
    const payload = {
      topic: s.ntfyTopic,
      title: n.title,
      message: n.body,
      priority,
      tags: n.tags ?? [],
      ...(n.path ? { click: abs(n.path) } : {}),
      actions: (n.actions ?? []).slice(0, 3).map((a) => ({ action: 'view', label: a.label, url: abs(a.path), clear: true })),
    }
    const result = !s.ntfyEnabled || !s.ntfyTopic
      ? { ok: true as const, error: null }
      : yield* Effect.tryPromise({
      try: async () => {
        const res = await fetch(s.ntfyServer.replace(/\/$/, ''), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        })
        if (!res.ok) throw new NtfyError(`ntfy ${res.status}: ${await res.text()}`)
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    }).pipe(
      Effect.retry(Schedule.exponential(Duration.seconds(1)).pipe(Schedule.upTo({ times: 2 }))),
      Effect.map(() => ({ ok: true as const, error: null })),
      Effect.catch((e: Error) => Effect.succeed({ ok: false as const, error: e.message })),
    )
    db.insert(schema.notifications)
      .values({
        id: newId('ntf_'),
        kind: n.kind,
        title: n.title,
        body: n.body,
        url: n.path ?? null,
        priority,
        dedupeKey: n.dedupeKey ?? null,
        ok: result.ok,
        error: result.error,
        at: nowIso(),
      })
      .run()
    return result
  })

export const notifyPromise = (n: Notice) => Effect.runPromise(notify(n))
