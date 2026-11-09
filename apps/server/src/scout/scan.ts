import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or } from 'drizzle-orm'
import { Effect } from 'effect'
import { logActivity } from '../activity'
import { ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { newId, nowIso, toIsoDate } from '../ids'
import { type AppSettings, getSettings } from '../settings'
import { parseComp } from '../text'
import { foreignPlaces, placePasses, workplaceOf } from './workplace'
import { ADAPTERS, AGGREGATOR_KINDS, DETAILS, detectAts, isAdapterKind, LIST_CAP, minPollMinutes, PORTFOLIO_KINDS, type RawJob } from './adapters'

type Filters = ReturnType<typeof compileFilters>

/** The scout's filters. Remote only when remote is the only way the user said they'll work. */
export const compileFilters = (s: AppSettings['scout'], workModes: readonly string[] = getSettings().search.workModes) => {
  const safe = (p: string) => {
    try {
      return new RegExp(p, 'i')
    } catch {
      return null
    }
  }
  const locationOk = s.locationOk ? safe(s.locationOk) : null
  return {
    include: s.titleInclude.map(safe).filter((r): r is RegExp => r !== null),
    exclude: s.titleExclude.map(safe).filter((r): r is RegExp => r !== null),
    locationOk,
    remote: safe(s.remoteWords),
    block: s.locationBlock ? safe(s.locationBlock) : null,
    foreign: foreignPlaces(locationOk),
    remoteOnly: workModes.length > 0 && workModes.every((m) => m === 'remote'),
    maxAgeDays: s.maxAgeDays,
    boardMaxAgeDays: s.boardMaxAgeDays,
  }
}

/** A place the user can work, or remote without naming a place they can't (see `placePasses`). */
export const locationPasses = (loc: string | null | undefined, f: Filters) => placePasses(loc, f)

/**
 * Cheap first-pass filter. AI triage makes the real call. No title filters means every title passes.
 * For a remote-only search, a posting must show it's remote (`workplaceOf`); one that can't tell yet
 * (no description) passes and is checked again once its description is read.
 * `maxAgeDays` is the feed limit by default; company boards pass their own, longer one (a board lists
 * only what's open, and senior roles stay up for months), and 0 or false skips the age check.
 */
export const heuristic = (job: Pick<RawJob, 'title' | 'location' | 'postedAt'> & { jd?: string | null }, f: Filters, maxAgeDays: number | false = f.maxAgeDays) => {
  const t = job.title
  if (f.include.length && !f.include.some((r) => r.test(t))) return 'fail: title'
  if (f.exclude.some((r) => r.test(t))) return 'fail: title excluded'
  if (!locationPasses(job.location, f)) return 'fail: location'
  if (f.remoteOnly && workplaceOf(job) === 'not remote') return 'fail: not remote'
  if (maxAgeDays && job.postedAt) {
    const posted = new Date(job.postedAt).getTime()
    if (!Number.isNaN(posted) && Date.now() - posted > maxAgeDays * 86400_000) return 'fail: old'
  }
  return 'pass'
}

/**
 * A company sweep (a lead turned up there) lets through any engineering title the user's title
 * filters drop, since the company is already known to be worth a look. Place and remote still apply.
 */
export const SWEPT = 'pass: company sweep'
const SWEEP_TITLE = /\b(engineer(ing)?|developer|architect|cto|technical|technology)\b/i
const passes = (h: string | null) => h === 'pass' || h === SWEPT

/** Filter verdicts the scout gave, as opposed to "duplicate of …" from resolving. These get a second look. */
const filteredOut = (h: string | null) => !!h && h.startsWith('fail:')

/** Most descriptions read per source per scan; the rest are read on later polls. */
const MAX_DETAILS = 60

export interface ScanResult {
  sourceId: string
  ok: boolean
  jobs: number
  new: number
  newPass: number
  /** Postings the filters had dropped that pass them now (the filters changed). */
  revived?: number
  error?: string
}

const scanSource = (source: schema.Source, f: Filters, sweep = false) =>
  Effect.gen(function* () {
    if (!isAdapterKind(source.kind)) return { sourceId: source.id, ok: false, jobs: 0, new: 0, newPass: 0, error: 'no adapter' }
    const started = nowIso()
    const fetched = yield* ADAPTERS[source.kind](source.board).pipe(Effect.result)
    if (fetched._tag === 'Failure') {
      const error = fetched.failure.message.slice(0, 300)
      db.update(schema.sources).set({ lastCheckedAt: started, lastError: error }).where(eq(schema.sources.id, source.id)).run()
      return { sourceId: source.id, ok: false, jobs: 0, new: 0, newPass: 0, error }
    }
    const jobs = fetched.success.filter((j) => j.extId && j.title)
    // First scan of a source: everything is "new" to us but not new to the world. Don't notify the user about it.
    const initial = source.lastCheckedAt === null
    const isAggregator = AGGREGATOR_KINDS.has(source.kind)
    const isPortfolio = PORTFOLIO_KINDS.has(source.kind)
    const maxAge = isAggregator && !isPortfolio ? f.maxAgeDays : f.boardMaxAgeDays
    const keys = jobs.map((j) => `${source.kind}:${source.board}:${j.extId}`)
    const known = new Map<string, { heuristic: string | null; recheck: boolean }>()
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500)
      for (const r of db
        .select({ key: schema.postings.key, heuristic: schema.postings.heuristic, triageStatus: schema.postings.triageStatus, userStatus: schema.postings.userStatus, applicationId: schema.postings.applicationId })
        .from(schema.postings)
        .where(inArray(schema.postings.key, chunk))
        .all())
        // Dropped by the filters and untouched since: the filters may have changed, so it gets another look.
        known.set(r.key, { heuristic: r.heuristic, recheck: r.triageStatus === 'skipped' && filteredOut(r.heuristic) && r.userStatus === 'new' && !r.applicationId })
    }
    const verdictOf = (j: RawJob) => {
      const h = heuristic(j, f, maxAge)
      return sweep && h === 'fail: title' && heuristic(j, { ...f, include: [SWEEP_TITLE] }, maxAge) === 'pass' ? SWEPT : h
    }
    // Verdicts up front: new postings, and filtered-out ones the current filters may now let through.
    const verdicts = jobs.map((j, i) => {
      const k = known.get(keys[i]!)
      return !k || k.recheck ? verdictOf(j) : null
    })
    // Boards whose list has no descriptions: read them for the postings that will be triaged.
    const detail = DETAILS[source.kind]
    const unread = new Set<number>()
    if (detail) {
      // An aggregator listing that links to an ATS Sidedoor reads gets the company's full posting when resolved.
      const resolvable = (j: RawJob) => isAggregator && !!(detectAts(j.applyUrl) ?? detectAts(j.url))
      const need = verdicts.flatMap((v, i) => (passes(v) && !jobs[i]!.jd && !resolvable(jobs[i]!) ? [i] : []))
      for (const i of need.slice(MAX_DETAILS)) unread.add(i)
      yield* Effect.forEach(
        need.slice(0, MAX_DETAILS),
        (i) =>
          detail(source.board, jobs[i]!).pipe(
            Effect.option,
            Effect.map((d) => {
              if (d._tag === 'None') return
              const merged = { ...jobs[i]!, ...Object.fromEntries(Object.entries(d.value).filter(([, v]) => v !== undefined && v !== '')) }
              jobs[i] = merged
              // The full posting can say more about where (a list's "3 Locations"); filter it again.
              verdicts[i] = verdictOf(merged)
            }),
          ),
        { concurrency: 3, discard: true },
      )
    }
    // A resolved aggregator listing was rekeyed to the company's board; its old URL lives on as viaUrl.
    const resolved = new Set<string>()
    if (isAggregator) {
      const urls = jobs.filter((j, i) => j.url && !known.has(keys[i]!)).map((j) => j.url!)
      for (let i = 0; i < urls.length; i += 500)
        for (const r of db.select({ viaUrl: schema.postings.viaUrl }).from(schema.postings).where(inArray(schema.postings.viaUrl, urls.slice(i, i + 500))).all())
          if (r.viaUrl) resolved.add(r.viaUrl)
    }
    let fresh = 0
    let pass = 0
    let revived = 0
    db.transaction((tx) => {
      for (const [i, j] of jobs.entries()) {
        const key = keys[i]!
        const k = known.get(key)
        const h = verdicts[i] ?? null
        if (k) {
          const seen = { lastSeenAt: started, closedAt: null }
          if (passes(h) && !unread.has(i)) {
            revived++
            tx.update(schema.postings).set({ ...seen, heuristic: h, triageStatus: 'pending', jd: j.jd.slice(0, 40_000), location: j.location || null }).where(eq(schema.postings.key, key)).run()
          } else if (h && !passes(h) && h !== k.heuristic) tx.update(schema.postings).set({ ...seen, heuristic: h }).where(eq(schema.postings.key, key)).run()
          else tx.update(schema.postings).set(seen).where(eq(schema.postings.key, key)).run()
          continue
        }
        if (j.url && resolved.has(j.url)) continue
        // Worth triaging but its description isn't read yet: it waits for the next poll.
        if (unread.has(i)) continue
        fresh++
        const companyName = (isAggregator ? j.company : undefined) ?? j.company ?? undefined
        let companyId = source.companyId
        let displayCompany = companyName ?? null
        if (isAggregator && companyName) {
          companyId = ensureCompany(companyName).id
        } else if (companyId) {
          displayCompany = tx.select({ name: schema.companies.name }).from(schema.companies).where(eq(schema.companies.id, companyId)).get()?.name ?? displayCompany
        }
        if (passes(h)) pass++
        const comp = parseComp(j.comp)
        tx.insert(schema.postings)
          .values({
            id: newId('job_'),
            key,
            sourceId: source.id,
            companyId,
            companyName: displayCompany,
            title: j.title.slice(0, 300),
            location: j.location || null,
            url: j.url ?? null,
            applyUrl: j.applyUrl ?? null,
            postedAt: toIsoDate(j.postedAt),
            firstSeenAt: started,
            lastSeenAt: started,
            compText: j.comp ?? null,
            compMin: comp.min,
            compMax: comp.max,
            // Only keep full descriptions for postings that may be triaged; keeps the DB small.
            jd: passes(h) ? j.jd.slice(0, 40_000) : null,
            heuristic: h,
            triageStatus: passes(h) ? 'pending' : 'skipped',
            notifiedAt: initial ? 'initial-scan' : null,
          })
          .onConflictDoNothing()
          .run()
      }
      // A company board that stopped listing a posting has closed it. Not feeds (listings roll off them
      // while still open; portfolio boards list everything open, so they count), not an empty read (a
      // board hiccup), not a list cut off at its cap (the rest is further down), and only after a day missing.
      const partial = fetched.success.length >= (LIST_CAP[source.kind] ?? Infinity)
      if ((!isAggregator || isPortfolio) && !partial && jobs.length > 0)
        tx.update(schema.postings)
          .set({ closedAt: started })
          .where(and(eq(schema.postings.sourceId, source.id), isNull(schema.postings.closedAt), lt(schema.postings.lastSeenAt, new Date(Date.parse(started) - 24 * 3600_000).toISOString())))
          .run()
      tx.update(schema.sources)
        .set({
          lastCheckedAt: started,
          lastError: null,
          lastJobCount: jobs.length,
          matchesTotal: source.matchesTotal + pass + revived,
        })
        .where(eq(schema.sources.id, source.id))
        .run()
    })
    return { sourceId: source.id, ok: true, jobs: jobs.length, new: fresh, newPass: pass, revived }
  })

/** Sources whose poll interval has elapsed. Some kinds have a floor (see `minPollMinutes`), even when forced. */
export const dueSources = (s = getSettings().scout, force = false) => {
  const active = db.select().from(schema.sources).where(eq(schema.sources.status, 'active')).all()
  const now = Date.now()
  return active.filter((src) => {
    if (!src.lastCheckedAt) return true
    const floor = minPollMinutes(src.kind, src.board)
    const mins = force ? floor : Math.max(floor, src.tier === 'hot' ? s.hotIntervalMin : s.normalIntervalMin)
    return now - new Date(src.lastCheckedAt).getTime() >= mins * 60_000 - 5_000
  })
}

/** Poll every due source (10 at a time) and record new postings. `sweep`: a company sweep (see SWEPT). */
export const scan = (opts: { force?: boolean; sourceIds?: string[]; sweep?: boolean } = {}) =>
  Effect.gen(function* () {
    const settings = getSettings()
    const f = compileFilters(settings.scout)
    let due = dueSources(settings.scout, opts.force)
    if (opts.sourceIds) {
      const ids = new Set(opts.sourceIds)
      due = db.select().from(schema.sources).all().filter((s) => ids.has(s.id))
    }
    if (due.length === 0) return { sources: 0, errors: 0, jobs: 0, new: 0, newPass: 0, revived: 0 }
    const results = yield* Effect.forEach(due, (src) => scanSource(src, f, opts.sweep), { concurrency: 10 })
    const total = results.reduce(
      (a, r) => ({ sources: a.sources + 1, errors: a.errors + (r.ok ? 0 : 1), jobs: a.jobs + r.jobs, new: a.new + r.new, newPass: a.newPass + r.newPass, revived: a.revived + (r.revived ?? 0) }),
      { sources: 0, errors: 0, jobs: 0, new: 0, newPass: 0, revived: 0 },
    )
    if (total.newPass > 0) logActivity('scout', `Scout found ${total.newPass} new matching posting${total.newPass === 1 ? '' : 's'}`, { detail: `${total.sources} sources checked, ${total.new} new postings overall`, link: '/jobs' })
    if (total.revived > 0) logActivity('scout', `${total.revived} posting${total.revived === 1 ? '' : 's'} the filters had dropped pass them now`, { detail: 'They go to scoring like new ones.', link: '/jobs' })
    return total
  })

/**
 * Postings ready for scoring, newest first. An aggregator listing waits until it's matched to the
 * company's original (resolve.ts), so only originals are scored. Each waiting posting passes the
 * filters again first: they may have changed since it was found, and its description, read since,
 * may show it isn't remote. One that fails now is set aside with the reason, without a scoring call.
 */
export const readyToScore = (limit: number) => {
  const f = compileFilters(getSettings().scout)
  const aggregators = db.select({ id: schema.sources.id }).from(schema.sources).where(inArray(schema.sources.kind, [...AGGREGATOR_KINDS])).all().map((r) => r.id)
  const original = aggregators.length ? or(isNull(schema.postings.sourceId), notInArray(schema.postings.sourceId, aggregators), isNotNull(schema.postings.resolvedAt)) : undefined
  const ready: schema.Posting[] = []
  for (;;) {
    const rows = db
      .select()
      .from(schema.postings)
      .where(and(eq(schema.postings.triageStatus, 'pending'), isNull(schema.postings.closedAt), original))
      .orderBy(desc(schema.postings.firstSeenAt))
      .limit(limit)
      .offset(ready.length)
      .all()
    for (const p of rows) {
      const job = { title: p.title, location: p.location ?? '', jd: p.jd }
      const h = p.applicationId ? 'pass' : heuristic(job, p.heuristic === SWEPT ? { ...f, include: [] } : f, false)
      // Last check before scoring: no description is coming, so one that never says remote isn't.
      const verdict = h === 'pass' && !p.applicationId && f.remoteOnly && workplaceOf(job, true) === 'not remote' ? 'fail: not remote' : h
      if (verdict === 'pass') ready.push(p)
      else db.update(schema.postings).set({ triageStatus: 'skipped', heuristic: verdict }).where(eq(schema.postings.id, p.id)).run()
    }
    if (ready.length >= limit || rows.length < limit) return ready.slice(0, limit)
  }
}
