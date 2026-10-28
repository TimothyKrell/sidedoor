import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, sql } from 'drizzle-orm'
import { Duration, Effect, Fiber, Ref, Schedule } from 'effect'
import { logActivity } from '../activity'
import { grokBotTick } from './handoff'
import { claimNextTask, executeTask, runTriage } from './tasks'
import { db, schema } from '../db/client'
import { nowIso, today } from '../ids'
import { notify } from '../notify'
import { scan } from '../scout/scan'
import { setStage } from '../services/applications'
import { enqueueTask, prepInProgress } from '../services/tasks'
import { getMeta, getSettings, setMeta } from '../settings'
import { readyProviders } from '../ai'

/**
 * Background work, in the server process: the scout polls job boards, triage scores new postings,
 * the task queue runs AI jobs, and the scheduler starts daily work. Nothing AI-shaped runs until
 * onboarding is done and an AI is connected.
 */
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`)

const ready = () => !!getSettings().onboarding.completedAt

/** Swallow and log failures so one bad iteration never kills a loop. */
const guarded = <A, E>(name: string, eff: Effect.Effect<A, E>) =>
  eff.pipe(
    Effect.catchCause((cause) => Effect.sync(() => log(`[${name}] failed: ${String(cause).slice(0, 800)}`))),
    Effect.asVoid,
  )

// --- scout + triage ---------------------------------------------------------------------------

const scoutTick = Effect.gen(function* () {
  const s = getSettings()
  const requested = getMeta<string>('scoutNow')
  const lastForced = getMeta<string>('scoutNowHandled')
  const force = !!requested && requested !== lastForced
  if ((!s.scout.enabled || !ready()) && !force) return
  if (force) setMeta('scoutNowHandled', requested)
  const r = yield* scan({ force })
  if (r.sources) log(`[scout] ${r.sources} sources, ${r.jobs} jobs, ${r.new} new, ${r.newPass} new matches, ${r.errors} errors`)
  setMeta('lastScan', { at: nowIso(), ...r })
})

// Triage runs on its own loop so a slow AI batch never delays polling.
const triageTick = Effect.promise(async () => (ready() && getSettings().ai.default ? runTriage() : { triaged: 0 })).pipe(
  Effect.tap((t) => Effect.sync(() => t.triaged && log(`[triage] ${JSON.stringify(t)}`))),
)

// --- AI task queue ------------------------------------------------------------------------

const taskLoop = Effect.gen(function* () {
  const running = yield* Ref.make(0)
  // Anything left "running" belongs to a previous process that died: run it again, unless it has
  // already been interrupted twice (it may be what's taking the server down).
  // Grok Bot's tasks run on its computer, not in this process: they keep going.
  const ours = and(eq(schema.tasks.status, 'running'), sql`coalesce(${schema.tasks.provider}, '') <> 'grokbot'`)
  db.update(schema.tasks)
    .set({ status: 'failed', error: 'Stopped twice when Sidedoor quit or crashed while it ran; not retrying. Use Retry to run it again.', finishedAt: nowIso() })
    .where(and(ours, gte(schema.tasks.attempts, 2)))
    .run()
  db.update(schema.tasks).set({ status: 'queued', startedAt: null }).where(ours).run()
  yield* Effect.gen(function* () {
    const s = getSettings().worker
    if (s.paused) return
    while ((yield* Ref.get(running)) < s.concurrency) {
      const task = claimNextTask()
      if (!task) break
      log(`[task] start ${task.kind}: ${task.title}`)
      yield* Ref.update(running, (n) => n + 1)
      yield* Effect.promise(() => executeTask(task)).pipe(
        Effect.ensuring(Ref.update(running, (n) => n - 1)),
        Effect.tap(() => Effect.sync(() => log(`[task] end ${task.kind}: ${task.title}`))),
        Effect.forkDetach,
      )
    }
  }).pipe((e) => guarded('tasks', e), Effect.repeat(Schedule.spaced(Duration.seconds(3))))
})

// --- daily / periodic schedule -----------------------------------------------------------------

const due = (key: string, everyMs: number) => {
  const last = getMeta<string>(key)
  return !last || Date.now() - new Date(last).getTime() >= everyMs
}
const onceToday = (key: string, hour: number) => new Date().getHours() >= hour && getMeta<string>(key) !== today()

const digest = Effect.gen(function* () {
  const t = today()
  const duePeople = db.select().from(schema.people).where(and(isNotNull(schema.people.nextContactAt), lte(schema.people.nextContactAt, t))).orderBy(schema.people.nextContactAt).all()
  const dueApps = db
    .select()
    .from(schema.applications)
    .where(and(isNotNull(schema.applications.nextActionDate), lte(schema.applications.nextActionDate, t), inArray(schema.applications.status, ['potential', 'active'])))
    .all()
  const review = db.select({ n: sql<number>`count(*)` }).from(schema.applications).where(eq(schema.applications.stage, 'review')).get()?.n ?? 0
  const approved = db.select({ n: sql<number>`count(*)` }).from(schema.applications).where(eq(schema.applications.stage, 'approved')).get()?.n ?? 0
  const since = new Date(Date.now() - 24 * 3600_000).toISOString()
  const fresh = db
    .select()
    .from(schema.postings)
    .where(and(gte(schema.postings.firstSeenAt, since), gte(schema.postings.fitScore, getSettings().triage.maybeFitScore), isNull(schema.postings.applicationId), eq(schema.postings.userStatus, 'new')))
    .orderBy(desc(schema.postings.fitScore))
    .limit(5)
    .all()
  const lines = [
    duePeople.length ? `${duePeople.length} follow-up${duePeople.length === 1 ? '' : 's'}: ${duePeople.slice(0, 4).map((p) => p.name).join(', ')}${duePeople.length > 4 ? '…' : ''}` : null,
    dueApps.length ? `${dueApps.length} application${dueApps.length === 1 ? '' : 's'} need action` : null,
    review ? `${review} package${review === 1 ? '' : 's'} to review` : null,
    approved ? `${approved} approved, waiting for you to submit` : null,
    fresh.length ? `New: ${fresh.map((p) => `${p.companyName} (${p.fitScore})`).join(', ')}` : null,
  ].filter((x): x is string => x !== null)
  if (lines.length === 0) return
  yield* notify({ kind: 'digest', title: `Today: ${lines.length} thing${lines.length === 1 ? '' : 's'} to do`, body: lines.join('\n'), path: '/', priority: 3, dedupeKey: `digest:${t}` })
})

/** Old data can say closed without being in the Closed stage; put it there so every count agrees. */
export const normalizeStages = () => {
  const A = schema.applications
  db.update(A).set({ stage: 'closed' }).where(and(inArray(A.status, ['closed-won', 'closed-lost']), sql`${A.stage} <> 'closed'`)).run()
}

/**
 * Keep the pipeline honest, whatever path got it here: an application you only marked interested
 * closes when its listing closes; one with prepared work (or work under way) is flagged instead.
 */
export const reconcile = () => {
  const A = schema.applications
  const preparing = prepInProgress()
  const closed = db
    .select({ id: A.id, stage: A.stage, companyName: A.companyName, role: A.role, closedAt: schema.postings.closedAt })
    .from(A)
    .innerJoin(schema.postings, eq(schema.postings.id, A.postingId))
    .where(and(inArray(A.stage, ['interested', 'review', 'approved']), isNotNull(schema.postings.closedAt)))
    .all()
  for (const a of closed) {
    // Nothing was done yet: close it. Work is waiting: keep it and tell you once per closing (the
    // application page shows the listing is gone); boards drop listings by mistake too.
    if (a.stage === 'interested' && !preparing.has(a.id)) setStage(a.id, 'closed', { closedReason: 'Listing closed', note: 'The company took the listing down' })
    else if (getMeta(`listingGone:${a.id}`) !== a.closedAt) {
      setMeta(`listingGone:${a.id}`, a.closedAt!)
      logActivity('application', `${a.companyName} took down the ${a.role} listing`, { detail: 'Your prepared application is kept. Check the company’s site before submitting.', link: `/applications/${a.id}` })
      Effect.runFork(notify({ kind: 'followup', title: `${a.companyName} took the listing down`, body: `${a.role}: check it is still open before you submit.`, path: `/applications/${a.id}`, dedupeKey: `gone:${a.id}` }))
    }
  }
}

const scheduleTick = Effect.gen(function* () {
  const s = getSettings()
  if (!ready()) return
  reconcile()
  // Daily AI work waits for a connected AI, so a new install doesn't queue failures.
  const aiReady = !!s.ai.default && (yield* Effect.promise(() => readyProviders())).length > 0
  if (aiReady && s.funding.enabled && due('lastFunding', s.funding.intervalHours * 3600_000)) {
    setMeta('lastFunding', nowIso())
    enqueueTask('funding', 'Funding radar: scan newly funded startups')
  }
  if (aiReady && s.discover.enabled && onceToday('lastDiscover', s.discover.hour)) {
    setMeta('lastDiscover', today())
    enqueueTask('discover', 'Discover new companies and job boards')
  }
  if (s.notify.digest && onceToday('lastDigest', s.notify.digestHour)) {
    setMeta('lastDigest', today())
    yield* digest
  }
})

// --- main ---------------------------------------------------------------------------------------

const main = Effect.gen(function* () {
  log('[jobs] starting')
  logActivity('system', 'Sidedoor started')
  yield* Effect.sync(reconcile).pipe((e) => guarded('reconcile', e))
  const scout = yield* scoutTick.pipe((e) => guarded('scout', e), Effect.repeat(Schedule.spaced(Duration.seconds(20))), Effect.forkChild)
  const triage = yield* triageTick.pipe((e) => guarded('triage', e), Effect.repeat(Schedule.spaced(Duration.seconds(15))), Effect.forkChild)
  const tasks = yield* taskLoop.pipe(Effect.forkChild)
  const sched = yield* scheduleTick.pipe((e) => guarded('schedule', e), Effect.repeat(Schedule.spaced(Duration.minutes(1))), Effect.forkChild)
  const grok = yield* Effect.promise(() => grokBotTick()).pipe((e) => guarded('grokbot', e), Effect.repeat(Schedule.spaced(Duration.seconds(15))), Effect.forkChild)
  yield* Fiber.joinAll([scout, triage, tasks, sched, grok])
})

/** Start the background loops. Returns a function that stops them. */
export const startJobs = () => {
  const fiber = Effect.runFork(main)
  return () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined)
}
