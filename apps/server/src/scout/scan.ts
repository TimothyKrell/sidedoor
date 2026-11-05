import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { Effect } from 'effect'
import { logActivity } from '../activity'
import { ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { newId, nowIso, toIsoDate } from '../ids'
import { type AppSettings, getSettings } from '../settings'
import { parseComp } from '../text'
import { ADAPTERS, AGGREGATOR_KINDS, DETAILS, isAdapterKind, LIST_CAP, minPollMinutes, type RawJob } from './adapters'

type Filters = ReturnType<typeof compileFilters>

export const compileFilters = (s: AppSettings['scout']) => {
  const safe = (p: string) => {
    try {
      return new RegExp(p, 'i')
    } catch {
      return null
    }
  }
  return {
    include: s.titleInclude.map(safe).filter((r): r is RegExp => r !== null),
    exclude: s.titleExclude.map(safe).filter((r): r is RegExp => r !== null),
    locationOk: safe(s.locationOk),
    remote: safe(s.remoteWords),
    block: safe(s.locationBlock),
    maxAgeDays: s.maxAgeDays,
    boardMaxAgeDays: s.boardMaxAgeDays,
  }
}

/**
 * A place the user can work, or remote without naming a place they can't. A missing location gets
 * the benefit of the doubt, and so does everything when the user set no location preferences.
 */
export const locationPasses = (loc: string | null | undefined, f: Filters) =>
  !loc || (!f.locationOk && !f.block) || !!(f.locationOk?.test(loc) || (f.remote?.test(loc) && !f.block?.test(loc)))

/**
 * Cheap first-pass filter. AI triage makes the real call. No title filters means every title passes.
 * `maxAgeDays` is the feed limit by default; company boards pass their own, longer one (a board lists
 * only what's open, and senior roles stay up for months), and 0 or false skips the age check.
 */
export const heuristic = (job: Pick<RawJob, 'title' | 'location' | 'postedAt'>, f: Filters, maxAgeDays: number | false = f.maxAgeDays) => {
  const t = job.title
  if (f.include.length && !f.include.some((r) => r.test(t))) return 'fail: title'
  if (f.exclude.some((r) => r.test(t))) return 'fail: title excluded'
  if (!locationPasses(job.location, f)) return 'fail: location'
  if (maxAgeDays && job.postedAt) {
    const posted = new Date(job.postedAt).getTime()
    if (!Number.isNaN(posted) && Date.now() - posted > maxAgeDays * 86400_000) return 'fail: old'
  }
  return 'pass'
}

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

const scanSource = (source: schema.Source, f: Filters) =>
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
    const maxAge = isAggregator ? f.maxAgeDays : f.boardMaxAgeDays
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
    // Verdicts up front: new postings, and filtered-out ones the current filters may now let through.
    const verdicts = jobs.map((j, i) => {
      const k = known.get(keys[i]!)
      return !k || k.recheck ? heuristic(j, f, maxAge) : null
    })
    // Boards whose list has no descriptions: read them for the postings that will be triaged.
    const detail = DETAILS[source.kind]
    const unread = new Set<number>()
    if (detail) {
      const need = verdicts.flatMap((v, i) => (v === 'pass' && !jobs[i]!.jd ? [i] : []))
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
              verdicts[i] = heuristic(merged, f, maxAge)
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
          if (h === 'pass' && !unread.has(i)) {
            revived++
            tx.update(schema.postings).set({ ...seen, heuristic: h, triageStatus: 'pending', jd: j.jd.slice(0, 40_000), location: j.location || null }).where(eq(schema.postings.key, key)).run()
          } else if (h && h !== 'pass' && h !== k.heuristic) tx.update(schema.postings).set({ ...seen, heuristic: h }).where(eq(schema.postings.key, key)).run()
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
        if (h === 'pass') pass++
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
            jd: h === 'pass' ? j.jd.slice(0, 40_000) : null,
            heuristic: h,
            triageStatus: h === 'pass' ? 'pending' : 'skipped',
            notifiedAt: initial ? 'initial-scan' : null,
          })
          .onConflictDoNothing()
          .run()
      }
      // A company board that stopped listing a posting has closed it. Not aggregators (listings roll off
      // their feeds while still open), not an empty read (a board hiccup), not a list cut off at its
      // cap (the rest is further down), and only after a day missing.
      const partial = fetched.success.length >= (LIST_CAP[source.kind] ?? Infinity)
      if (!isAggregator && !partial && jobs.length > 0)
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

/** Poll every due source (10 at a time) and record new postings. */
export const scan = (opts: { force?: boolean; sourceIds?: string[] } = {}) =>
  Effect.gen(function* () {
    const settings = getSettings()
    const f = compileFilters(settings.scout)
    let due = dueSources(settings.scout, opts.force)
    if (opts.sourceIds) {
      const ids = new Set(opts.sourceIds)
      due = db.select().from(schema.sources).all().filter((s) => ids.has(s.id))
    }
    if (due.length === 0) return { sources: 0, errors: 0, jobs: 0, new: 0, newPass: 0, revived: 0 }
    const results = yield* Effect.forEach(due, (src) => scanSource(src, f), { concurrency: 10 })
    const total = results.reduce(
      (a, r) => ({ sources: a.sources + 1, errors: a.errors + (r.ok ? 0 : 1), jobs: a.jobs + r.jobs, new: a.new + r.new, newPass: a.newPass + r.newPass, revived: a.revived + (r.revived ?? 0) }),
      { sources: 0, errors: 0, jobs: 0, new: 0, newPass: 0, revived: 0 },
    )
    if (total.newPass > 0) logActivity('scout', `Scout found ${total.newPass} new matching posting${total.newPass === 1 ? '' : 's'}`, { detail: `${total.sources} sources checked, ${total.new} new postings overall`, link: '/jobs' })
    if (total.revived > 0) logActivity('scout', `${total.revived} posting${total.revived === 1 ? '' : 's'} the filters had dropped pass them now`, { detail: 'They go to scoring like new ones.', link: '/jobs' })
    return total
  })
