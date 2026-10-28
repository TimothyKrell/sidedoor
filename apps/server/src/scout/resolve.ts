import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { newId, nowIso, slugify, toIsoDate } from '../ids'
import { relinkApplication } from '../services/applications'
import { getSettings } from '../settings'
import { parseComp } from '../text'
import { ADAPTERS, AGGREGATOR_KINDS, type AdapterKind, detectAts, isAdapterKind, probeBoard, type RawJob } from './adapters'
import { compileFilters, locationPasses } from './scan'

/**
 * Aggregators (Jobicy, Himalayas, WWR, ...) list jobs that live on a company's own ATS, often with a
 * truncated description and an apply button behind a signup wall. For each one worth a look, find the
 * company's board, match the title, and swap in the real posting: its URL, apply link and full JD.
 */

const BOARD_KINDS = ['ashby', 'greenhouse', 'lever', 'workable', 'smartrecruiters'] as const
const RECHECK_DAYS = 14

export const normTitle = (t: string) =>
  t
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b(sr)\b\.?/g, 'senior')
    .replace(/\((?:remote|hybrid|us|usa|united states)[^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(remote|usa?|united states)\s*$/g, '')
    .trim()

const tokens = (t: string) => new Set(normTitle(t).split(' ').filter(Boolean))

/** The board job with the same title, or a near-identical one if exactly one stands out. */
export const matchTitle = (title: string, jobs: RawJob[], company?: string): RawJob | null => {
  // Some feeds append the company: "Senior Engineer at Shakepay".
  if (company) title = title.replace(new RegExp(`\\s+(?:at|@)\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '')
  const want = normTitle(title)
  const exact = jobs.filter((j) => normTitle(j.title) === want)
  if (exact.length) return exact.find((j) => /remote|united states|\bus\b|usa/i.test(j.location)) ?? exact[0]!
  const a = tokens(title)
  const scored = jobs
    .map((j) => {
      const b = tokens(j.title)
      const inter = [...a].filter((x) => b.has(x)).length
      return { j, score: inter / (a.size + b.size - inter || 1) }
    })
    .filter((s) => s.score >= 0.8)
    .sort((x, y) => y.score - x.score)
  if (!scored.length || (scored[1] && scored[1].score === scored[0]!.score)) return null
  return scored[0]!.j
}

type Board = { kind: AdapterKind; board: string; sourceId: string | null }

/** Fetches each board at most once per pass. */
const boardJobs = new Map<string, Promise<RawJob[] | null>>()
const jobsOf = (b: { kind: AdapterKind; board: string }) => {
  const k = `${b.kind}:${b.board}`
  if (!boardJobs.has(k)) boardJobs.set(k, Effect.runPromise(ADAPTERS[b.kind](b.board).pipe(Effect.option)).then((o) => (o._tag === 'Some' ? o.value : null)))
  return boardJobs.get(k)!
}

/** Slug-probe results per company for this pass, so a company's second listing doesn't re-probe or miss out. */
const probed = new Map<string, Array<{ kind: AdapterKind; board: string; jobs: RawJob[] }>>()

const knownBoard = (company: schema.Company): Board | null => {
  const src = db
    .select()
    .from(schema.sources)
    .where(and(eq(schema.sources.companyId, company.id), inArray(schema.sources.kind, [...BOARD_KINDS])))
    .get()
  if (src && isAdapterKind(src.kind)) return { kind: src.kind, board: src.board, sourceId: src.id }
  if (company.atsKind && company.atsBoard && isAdapterKind(company.atsKind)) return { kind: company.atsKind, board: company.atsBoard, sourceId: null }
  return null
}

/** Name variants: "Kraken (Payward)" is Kraken, "Proxify AB" is Proxify. */
const altSlugs = (company: schema.Company) => {
  const bare = company.name.replace(/\([^)]*\)/g, ' ').replace(/\b(AB|GmbH|Inc|LLC|Ltd|S\.?A)\.?\s*$/i, '').trim()
  return [...new Set([slugify(bare), slugify(bare.split(/\s+/)[0] ?? '')])].filter((x) => x.length >= 3 && x !== company.slug)
}

const guesses = (company: schema.Company) =>
  [
    ...new Set(
      [company.slug, ...altSlugs(company)]
        .flatMap((s) => [s.replace(/-/g, ''), s])
        .concat(company.domain?.split('.')[0] ?? [])
        .filter((x): x is string => !!x),
    ),
  ]

/** A board we already know under another spelling of the company. */
const aliasBoard = (company: schema.Company): Board | null => {
  for (const slug of altSlugs(company)) {
    const other = db.select().from(schema.companies).where(eq(schema.companies.slug, slug)).get()
    const b = other && knownBoard(other)
    if (b) return { ...b, sourceId: null }
  }
  return null
}

/**
 * The company's own ATS board and its open jobs: the board Sidedoor knows, else the usual ATSs
 * probed under the company's name. Unlike resolving, nothing needs to match, so a probed board
 * could belong to a namesake; callers show which board they used.
 */
export const companyBoard = async (company: schema.Company): Promise<{ kind: AdapterKind; board: string; jobs: RawJob[] } | null> => {
  const known = knownBoard(company) ?? aliasBoard(company)
  if (known) {
    const jobs = await Effect.runPromise(ADAPTERS[known.kind](known.board))
    return { kind: known.kind, board: known.board, jobs }
  }
  for (const g of guesses(company)) {
    const r = await Effect.runPromise(probeBoard(g))
    if (r) return r
  }
  return null
}

type Found = { board: Board; job: RawJob }

/** Find this posting on the company's own board. Probes slug guesses once per company per RECHECK_DAYS. */
const findDirect = async (p: schema.Posting, company: schema.Company): Promise<Found | null> => {
  const linked = detectAts(p.applyUrl) ?? detectAts(p.url)
  const known = linked ? { ...linked, sourceId: null } : (knownBoard(company) ?? aliasBoard(company))
  if (known) {
    const jobs = await jobsOf(known)
    const job = jobs && matchTitle(p.title, jobs, company.name)
    return job ? { board: known, job } : null
  }
  let boards = probed.get(company.id)
  if (!boards) {
    const checked = company.atsCheckedAt ? Date.now() - new Date(company.atsCheckedAt).getTime() < RECHECK_DAYS * 86400_000 : false
    if (checked) return null
    db.update(schema.companies).set({ atsCheckedAt: nowIso() }).where(eq(schema.companies.id, company.id)).run()
    boards = []
    for (const g of guesses(company)) {
      const r = await Effect.runPromise(probeBoard(g))
      if (r) boards.push(r)
    }
    probed.set(company.id, boards)
  }
  for (const r of boards) {
    const job = matchTitle(p.title, r.jobs, company.name)
    // A slug can belong to a different company; only trust the board once a title matches.
    if (job) {
      db.update(schema.companies).set({ atsKind: r.kind, atsBoard: r.board, updatedAt: nowIso() }).where(eq(schema.companies.id, company.id)).run()
      return { board: { kind: r.kind, board: r.board, sourceId: null }, job }
    }
  }
  return null
}

/** The company board as a candidate source, so it shows on Sources ready to switch on. */
const ensureBoardSource = (b: Board, company: schema.Company, via: string) => {
  if (b.sourceId) return b.sourceId
  db.insert(schema.sources)
    .values({ id: newId('src_'), name: company.name, kind: b.kind, board: b.board, url: null, companyId: company.id, status: 'candidate', why: `Found via ${via}`, origin: 'aggregator' })
    .onConflictDoNothing()
    .run()
  return db.select({ id: schema.sources.id }).from(schema.sources).where(and(eq(schema.sources.kind, b.kind), eq(schema.sources.board, b.board))).get()!.id
}

const hostOf = (url: string | null) => {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, '') : 'an aggregator'
  } catch {
    return 'an aggregator'
  }
}

export type ResolveOutcome = 'resolved' | 'duplicate' | 'not-found'

/**
 * Aggregators flatten location ("Remote" in a USA feed), so the company's own posting gets the
 * location filter again. Not yet triaged: it's filtered out like any other. Already triaged or
 * tracked: it's flagged, since the user may be mid-way through it.
 */
const locationRecheck = (p: schema.Posting, location: string | null): Partial<schema.Posting> => {
  if (location === p.location || locationPasses(location, compileFilters(getSettings().scout))) return {}
  if (p.triageStatus === 'pending' && !p.applicationId) return { triageStatus: 'skipped', heuristic: 'fail: location' }
  return { locationFit: 'no', locationNote: `The company's posting lists ${location?.replace(/\s*\|\s*/g, ' · ')}` }
}

const apply = (p: schema.Posting, company: schema.Company, { board, job }: Found): ResolveOutcome => {
  const at = nowIso()
  const key = `${board.kind}:${board.board}:${job.extId}`
  const url = job.url ?? job.applyUrl ?? p.url
  const applyUrl = job.applyUrl ?? job.url ?? p.applyUrl
  const oldLinks = [p.url, p.applyUrl].filter((x): x is string => !!x)
  const location = job.location || p.location
  const relink = () => p.applicationId && url && applyUrl && relinkApplication(p.applicationId, { links: oldLinks, location: p.location }, { jobUrl: url, applyUrl, location })
  const fuller = job.jd && job.jd.length > (p.jd?.length ?? 0) ? job.jd.slice(0, 40_000) : p.jd
  const comp = p.compText ? null : job.comp ? { text: job.comp, ...parseComp(job.comp) } : null
  const details = {
    title: job.title.slice(0, 300) || p.title,
    url,
    applyUrl,
    viaUrl: p.viaUrl ?? p.url,
    companyId: company.id,
    jd: fuller,
    location,
    postedAt: toIsoDate(job.postedAt) ?? p.postedAt,
    ...(comp ? { compText: comp.text, compMin: comp.min, compMax: comp.max } : {}),
    ...locationRecheck(p, location),
    resolvedAt: at,
  }
  return db.transaction((tx) => {
    const twin = tx.select().from(schema.postings).where(eq(schema.postings.key, key)).get()
    if (twin && twin.id !== p.id) {
      const twinIdle = !twin.applicationId && twin.userStatus === 'new' && twin.triageStatus === 'skipped'
      const selfIdle = !p.applicationId && p.userStatus === 'new'
      if (selfIdle && !twinIdle) {
        // We already have the company's copy; this listing adds nothing, so it leaves the feed. It
        // still gets the real links, in case the user opens or tracks it from a link they kept.
        tx.update(schema.postings).set({ ...details, triageStatus: 'skipped', heuristic: `duplicate of ${twin.id}` }).where(eq(schema.postings.id, p.id)).run()
        return 'duplicate'
      }
      if (twinIdle) {
        // The board copy was filtered out (often on location), but this one is in play: it takes over the key.
        tx.delete(schema.postings).where(eq(schema.postings.id, twin.id)).run()
      } else {
        // Both are in use. Point this one at the real posting and leave the records alone.
        tx.update(schema.postings).set(details).where(eq(schema.postings.id, p.id)).run()
        relink()
        return 'resolved'
      }
    }
    const sourceId = ensureBoardSource(board, company, hostOf(p.url))
    tx.update(schema.postings).set({ ...details, key, sourceId }).where(eq(schema.postings.id, p.id)).run()
    relink()
    return 'resolved'
  })
}

export const resolvePosting = async (p: schema.Posting): Promise<ResolveOutcome> => {
  if (!p.companyName) return 'not-found'
  const company = p.companyId
    ? (db.select().from(schema.companies).where(eq(schema.companies.id, p.companyId)).get() ?? ensureCompany(p.companyName))
    : ensureCompany(p.companyName)
  const found = await findDirect(p, company).catch(() => null)
  if (!found) {
    db.update(schema.postings).set({ resolvedAt: nowIso() }).where(eq(schema.postings.id, p.id)).run()
    return 'not-found'
  }
  return apply(p, company, found)
}

/**
 * Resolve aggregator postings that made it past the title/location filter: pending ones first (so
 * triage reads the full JD), then tracked ones, then the rest by fit.
 */
export const resolveAggregatorPostings = async (limit = 25) => {
  const aggregatorSources = db
    .select({ id: schema.sources.id })
    .from(schema.sources)
    .where(inArray(schema.sources.kind, [...AGGREGATOR_KINDS]))
    .all()
    .map((s) => s.id)
  if (!aggregatorSources.length) return { resolved: 0, duplicate: 0, notFound: 0 }
  const rows = db
    .select()
    .from(schema.postings)
    .where(
      and(
        inArray(schema.postings.sourceId, aggregatorSources),
        isNull(schema.postings.resolvedAt),
        isNull(schema.postings.closedAt),
        isNotNull(schema.postings.companyName),
        ne(schema.postings.triageStatus, 'skipped'),
      ),
    )
    .orderBy(
      sql`${schema.postings.triageStatus} = 'pending' desc`,
      sql`${schema.postings.applicationId} is not null desc`,
      desc(schema.postings.fitScore),
    )
    .limit(limit)
    .all()
  boardJobs.clear()
  probed.clear()
  const counts = { resolved: 0, duplicate: 0, notFound: 0 }
  // One company's listings run in order (they share a probe); companies run in parallel.
  const byCompany = new Map<string, schema.Posting[]>()
  for (const p of rows) {
    const k = p.companyId ?? p.companyName ?? p.id
    byCompany.set(k, [...(byCompany.get(k) ?? []), p])
  }
  await Effect.runPromise(
    Effect.forEach(
      [...byCompany.values()],
      (group) =>
        Effect.promise(async () => {
          for (const p of group) {
            const o = await resolvePosting(p).catch((): ResolveOutcome => 'not-found')
            if (o === 'resolved') counts.resolved++
            else if (o === 'duplicate') counts.duplicate++
            else counts.notFound++
          }
        }),
      { concurrency: 4 },
    ),
  )
  boardJobs.clear()
  probed.clear()
  return counts
}
