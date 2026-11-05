import { and, inArray } from 'drizzle-orm'
import { decisionsOf } from '@sidedoor/shared/decisions'
import { reviewBucket, type ReviewFacts, writingItems } from '@sidedoor/shared/review'
import { db, schema } from './db/client'
import { submissions } from './jobs/fill-form'
import { matchStale } from './queries'
import { listQuestions } from './services/questions'
import { enqueueTask } from './services/tasks'

const A = schema.applications
const T = schema.tasks
const AI_KINDS: schema.TaskKind[] = ['prep', 'match', 'tune']

/** A rank you (or your AI) set first, then high priority, best odds, best fit: the pipeline's order. */
const order = (a: schema.Application, b: schema.Application) =>
  (a.rank ?? Infinity) - (b.rank ?? Infinity) ||
  (a.priority === 'high' ? -1 : 0) - (b.priority === 'high' ? -1 : 0) ||
  (b.shot ?? -1) - (a.shot ?? -1) ||
  (b.fitScore ?? 0) - (a.fitScore ?? 0)

/** Applications with a package that haven't gone out yet. */
const unsent = () => db.select().from(A).where(inArray(A.stage, ['review', 'approved'])).all().filter((a) => a.packageMd).sort(order)

/** Everything waiting on you before it goes out, and the step each one is on. */
export const reviewQueue = () => {
  const apps = unsent()
  const ids = apps.map((a) => a.id)
  const active = ids.length ? db.select({ applicationId: T.applicationId, kind: T.kind }).from(T).where(and(inArray(T.applicationId, ids), inArray(T.status, ['queued', 'running']))).all() : []
  const asked = new Map<string, number>()
  for (const q of listQuestions({ status: 'open' })) for (const x of q.applications) asked.set(x.id, (asked.get(x.id) ?? 0) + 1)
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
      writing: writing.map((w) => ({ key: w.key, title: w.title, blank: w.blank, done: w.done })),
      listingClosed: !!(a.postingId && closedAt.get(a.postingId)),
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

export type ReviewItem = ReturnType<typeof reviewQueue>[number]
