import { and, eq, inArray } from 'drizzle-orm'
import { decisionsOf } from '@sidedoor/shared/decisions'
import { reviewBucket, type ReviewFacts, writingItems } from '@sidedoor/shared/review'
import { db, schema } from './db/client'
import { submissions } from './jobs/fill-form'
import { appQueueScore, matchStale } from './queries'
import { listQuestions } from './services/questions'
import { enqueueTask } from './services/tasks'

const A = schema.applications
const T = schema.tasks
const AI_KINDS: schema.TaskKind[] = ['prep', 'match', 'tune']

/** A rank you (or your AI) set first, then work on first (newest listing, fit and pay), then best fit: the pipeline's order. */
const order = (a: schema.Application, b: schema.Application) =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
  appQueueScore(b, null) - appQueueScore(a, null) ||
  (b.fitScore ?? 0) - (a.fitScore ?? 0)

/** Applications with a package that haven't gone out yet. */
const unsent = () => db.select().from(A).where(inArray(A.stage, ['review', 'approved'])).all().filter((a) => a.packageMd).sort(order)

/** Everything waiting on you before it goes out, and the step each one is on. */
export const reviewQueue = () => {
  const apps = unsent()
  const ids = apps.map((a) => a.id)
  const active = ids.length ? db.select({ applicationId: T.applicationId, kind: T.kind }).from(T).where(and(inArray(T.applicationId, ids), inArray(T.status, ['queued', 'running']))).all() : []
  const asked = new Map<string, number>()
  const optional = new Map<string, number>()
  for (const q of listQuestions({ status: 'open' })) {
    const counts = q.optional ? optional : asked
    for (const x of q.applications) counts.set(x.id, (counts.get(x.id) ?? 0) + 1)
  }
  const sent = new Map(submissions().map((s) => [s.applicationId, s]))
  const closedAt = new Map(db.select({ id: schema.postings.id, closedAt: schema.postings.closedAt }).from(schema.postings).where(inArray(schema.postings.id, apps.flatMap((a) => (a.postingId ? [a.postingId] : [])))).all().map((p) => [p.id, p.closedAt]))

  return apps.map((a) => {
    const mine = active.filter((t) => t.applicationId === a.id)
    const writing = writingItems(a.packageMd, a.writingChecks)
    const s = sent.get(a.id) ?? null
    const real = s && !s.dryRun ? s : null
    const facts: ReviewFacts = {
      stage: a.stage,
      aiWorking: mine.some((t) => AI_KINDS.includes(t.kind)),
      tuned: !!a.tuneJson,
      openQuestions: asked.get(a.id) ?? 0,
      openDecisions: decisionsOf(a.packageMd).filter((d) => !d.done).length,
      writingLeft: writing.filter((w) => !w.done).length,
      sending: mine.some((t) => t.kind === 'submit-assist'),
      stuck: !!real && ['blocked', 'failed', 'not_submitted'].includes(real.status),
    }
    return {
      id: a.id,
      companyName: a.companyName,
      role: a.role,
      stage: a.stage,
      priority: a.priority,
      fitScore: a.fitScore,
      shot: a.shot,
      score: a.matchJson?.score ?? null,
      matchStale: matchStale(a),
      tune: a.tuneJson,
      facts,
      bucket: reviewBucket(facts),
      optionalQuestions: optional.get(a.id) ?? 0,
      writing: writing.map((w) => ({ key: w.key, title: w.title, blank: w.blank, done: w.done })),
      listingClosed: !!(a.listingClosedAt || (a.postingId && closedAt.get(a.postingId))),
      submission: s && { status: s.status, dryRun: s.dryRun, summary: s.summary },
    }
  })
}

/** Queue tuning for every waiting application that hasn't had it, in your order. Already-running ones aren't queued twice. */
export const tuneAll = () => {
  const todo = unsent().filter((a) => !a.tuneJson)
  for (const a of todo) enqueueTask('tune', `Tune resume: ${a.companyName} – ${a.role}`, { applicationId: a.id, priority: 1 })
  return { queued: todo.length }
}

/** Queue a job summary for everything waiting that has none. One try each: Summarize on the card asks again. */
export const queueBriefs = () => {
  const todo = unsent().filter((a) => !a.brief)
  if (!todo.length) return { queued: 0 }
  const tried = new Set(db.select({ applicationId: T.applicationId }).from(T).where(and(eq(T.kind, 'brief'), inArray(T.applicationId, todo.map((a) => a.id)))).all().map((t) => t.applicationId))
  const fresh = todo.filter((a) => !tried.has(a.id))
  for (const a of fresh) enqueueTask('brief', `Summarize job: ${a.companyName} – ${a.role}`, { applicationId: a.id, priority: 1 })
  return { queued: fresh.length }
}

export type ReviewItem = ReturnType<typeof reviewQueue>[number]
