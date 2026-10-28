import { and, eq, inArray } from 'drizzle-orm'
import { db, schema } from '../db/client'
import { newId, nowIso } from '../ids'

export interface EnqueueOptions {
  input?: Record<string, schema.Json>
  applicationId?: string | null
  postingId?: string | null
  personId?: string | null
  /** Higher runs first. Chat-initiated work uses 10, background 0. */
  priority?: number
  runAfter?: string
  /** Skip if an identical unfinished task already exists. */
  dedupe?: boolean
}

export const enqueueTask = (kind: schema.TaskKind, title: string, o: EnqueueOptions = {}) => {
  if (o.dedupe !== false) {
    const conds = [eq(schema.tasks.kind, kind), inArray(schema.tasks.status, ['queued', 'running'])]
    if (o.applicationId) conds.push(eq(schema.tasks.applicationId, o.applicationId))
    if (o.personId) conds.push(eq(schema.tasks.personId, o.personId))
    if (o.postingId) conds.push(eq(schema.tasks.postingId, o.postingId))
    if (o.applicationId || o.personId || o.postingId || kind === 'funding' || kind === 'discover' || kind === 'resume-notes') {
      const existing = db.select().from(schema.tasks).where(and(...conds)).get()
      if (existing) return existing
    }
  }
  const row = {
    id: newId('task_'),
    kind,
    title,
    input: o.input ?? {},
    applicationId: o.applicationId ?? null,
    postingId: o.postingId ?? null,
    personId: o.personId ?? null,
    priority: o.priority ?? 0,
    runAfter: o.runAfter ?? null,
    createdAt: nowIso(),
  }
  db.insert(schema.tasks).values(row).run()
  return db.select().from(schema.tasks).where(eq(schema.tasks.id, row.id)).get()!
}

export const cancelTask = (id: string) =>
  db.update(schema.tasks).set({ status: 'cancelled', finishedAt: nowIso() }).where(and(eq(schema.tasks.id, id), eq(schema.tasks.status, 'queued'))).run()

export const retryTask = (id: string) =>
  db.update(schema.tasks).set({ status: 'queued', error: null, startedAt: null, finishedAt: null, attempts: 0 }).where(eq(schema.tasks.id, id)).run()

/** What an application's AI prep is doing right now, if anything: shown on its card in the pipeline. */
export interface PrepWork {
  /** Revising a package after you asked for changes, rather than preparing a first one. */
  revision: boolean
  /** Running now, rather than waiting for a free slot. */
  running: boolean
}

/** Prep tasks that are queued or running, by application. */
export const prepInProgress = (): Map<string, PrepWork> => {
  const T = schema.tasks
  const rows = db.select({ applicationId: T.applicationId, status: T.status, input: T.input }).from(T).where(and(eq(T.kind, 'prep'), inArray(T.status, ['queued', 'running']))).all()
  const out = new Map<string, PrepWork>()
  for (const r of rows) {
    if (!r.applicationId) continue
    const prev = out.get(r.applicationId)
    out.set(r.applicationId, { revision: (prev?.revision ?? false) || r.input.revision === true, running: (prev?.running ?? false) || r.status === 'running' })
  }
  return out
}
