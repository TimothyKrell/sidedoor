import { Duration, Effect, Predicate, Schedule } from 'effect'
import { htmlToText } from '../text'

/** A posting normalized from any source. */
export interface RawJob {
  extId: string
  title: string
  company?: string | undefined
  location: string
  url?: string | undefined
  applyUrl?: string | undefined
  postedAt?: string | undefined
  jd: string
  comp?: string | undefined
}

export class FetchError extends Error {
  readonly _tag = 'FetchError'
  constructor(
    readonly url: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message)
  }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) sidedoor/1.0 (personal job search)'

const retryTransient = Schedule.exponential(Duration.millis(500)).pipe(
  Schedule.upTo({ times: 2 }),
  Schedule.setInputType<FetchError>(),
  Schedule.while(({ input }) => input.status === null || input.status >= 500 || input.status === 429),
)

export const fetchText = (url: string, timeoutMs = 25_000) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json, application/rss+xml, */*' },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new FetchError(url, res.status, `HTTP ${res.status}`)
      return res.text()
    },
    catch: (e) => (e instanceof FetchError ? e : new FetchError(url, null, e instanceof Error ? e.message : String(e))),
  }).pipe(Effect.retry(retryTransient))

export const fetchJson = (url: string) =>
  fetchText(url).pipe(
    Effect.flatMap((t) =>
      Effect.try({ try: (): unknown => JSON.parse(t), catch: () => new FetchError(url, null, 'invalid JSON') }),
    ),
  )

// ---- tiny accessors for untrusted JSON -------------------------------------------------------

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (Predicate.isObject(v) && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const str = (v: unknown): string | undefined =>
  Predicate.isString(v) ? v : Predicate.isNumber(v) ? String(v) : undefined
const joinLocs = (xs: Array<string | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].join(' | ')
const msToIso = (v: unknown) => (Predicate.isNumber(v) ? new Date(v).toISOString() : undefined)

// ---- adapters ------------------------------------------------------------------------------

const greenhouse = (board: string) =>
  fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`).pipe(
    Effect.map((d) =>
      arr(obj(d).jobs).map((raw): RawJob => {
        const j = obj(raw)
        const locs = [str(obj(j.location).name), ...arr(j.offices).map((o) => str(obj(o).name))]
        return {
          extId: str(j.id) ?? '',
          title: str(j.title) ?? '',
          company: str(j.company_name),
          location: joinLocs(locs),
          url: str(j.absolute_url),
          applyUrl: str(j.absolute_url),
          postedAt: str(j.first_published) ?? str(j.updated_at),
          jd: htmlToText(str(j.content) ?? ''),
        }
      }),
    ),
  )

const lever = (board: string) =>
  fetchJson(`https://api.lever.co/v0/postings/${board}?mode=json`).pipe(
    Effect.map((d) =>
      arr(d).map((raw): RawJob => {
        const j = obj(raw)
        const c = obj(j.categories)
        const locs = arr(c.allLocations).map(str)
        if (locs.length === 0) locs.push(str(c.location))
        locs.push(str(j.workplaceType))
        const lists = arr(j.lists)
          .map((l) => `${str(obj(l).text) ?? ''}\n${htmlToText(str(obj(l).content) ?? '')}`)
          .join('\n\n')
        const sr = obj(j.salaryRange)
        const comp = Predicate.isNumber(sr.min)
          ? `${sr.currency ?? ''} ${sr.min}-${sr.max} ${sr.interval ?? ''}`.trim()
          : undefined
        return {
          extId: str(j.id) ?? '',
          title: str(j.text) ?? '',
          location: joinLocs(locs),
          url: str(j.hostedUrl),
          applyUrl: str(j.applyUrl),
          postedAt: msToIso(j.createdAt),
          jd: [str(j.descriptionPlain), lists, str(j.additionalPlain)].filter(Boolean).join('\n\n').trim(),
          comp,
        }
      }),
    ),
  )

const ashby = (board: string) =>
  fetchJson(
    `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}?includeCompensation=true`,
  ).pipe(
    Effect.map((d) =>
      arr(obj(d).jobs)
        .map(obj)
        .filter((j) => j.isListed !== false)
        .map((j): RawJob => {
          const locs = [str(j.location), ...arr(j.secondaryLocations).map((s) => str(obj(s).location))]
          if (j.isRemote === true) locs.push('Remote')
          locs.push(str(j.workplaceType))
          return {
            extId: str(j.id) ?? '',
            title: str(j.title) ?? '',
            location: joinLocs(locs),
            url: str(j.jobUrl),
            applyUrl: str(j.applyUrl),
            postedAt: str(j.publishedAt),
            jd: str(j.descriptionPlain) ?? htmlToText(str(j.descriptionHtml) ?? ''),
            comp: str(obj(j.compensation).compensationTierSummary),
          }
        }),
    ),
  )

const workable = (board: string) =>
  fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${board}?details=true`).pipe(
    Effect.map((d) =>
      arr(obj(d).jobs)
        .map(obj)
        .map((j): RawJob => {
          const loc = [str(j.city), str(j.state), str(j.country)].filter(Boolean).join(', ')
          return {
            extId: str(j.shortcode) ?? '',
            title: str(j.title) ?? '',
            location: j.telecommuting === true ? `${loc} | Remote` : loc,
            url: str(j.url),
            applyUrl: str(j.application_url) ?? str(j.url),
            postedAt: str(j.published_on),
            jd: htmlToText(str(j.description) ?? ''),
          }
        }),
    ),
  )

const smartrecruiters = (board: string) =>
  fetchJson(`https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100`).pipe(
    Effect.map((d) =>
      arr(obj(d).content)
        .map(obj)
        .map((j): RawJob => {
          const l = obj(j.location)
          const loc = [str(l.city), str(l.region), str(l.country)].filter(Boolean).join(', ')
          const id = str(j.id) ?? ''
          return {
            extId: id,
            title: str(j.name) ?? '',
            location: l.remote === true ? `${loc} | Remote` : loc,
            url: `https://jobs.smartrecruiters.com/${board}/${id}`,
            postedAt: str(j.releasedDate),
            jd: '',
          }
        }),
    ),
  )

const remoteok = (board: string) =>
  fetchJson(`https://remoteok.com/api${board && board !== 'all' ? `?tag=${board}` : ''}`).pipe(
    Effect.map((d) =>
      arr(d)
        .slice(1)
        .map(obj)
        .map(
          (j): RawJob => ({
            extId: str(j.id) ?? '',
            title: str(j.position) ?? '',
            company: str(j.company),
            location: `${str(j.location) || 'Remote'} | Remote`,
            url: str(j.url),
            applyUrl: str(j.apply_url) ?? str(j.url),
            postedAt: str(j.date),
            jd: htmlToText(str(j.description) ?? ''),
            comp: Predicate.isNumber(j.salary_min) ? `$${j.salary_min}-$${j.salary_max}` : undefined,
          }),
        ),
    ),
  )

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'))
  if (!m?.[1]) return undefined
  return m[1].replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1').trim()
}

export const parseRss = (xml: string) =>
  [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].map((m) => {
    const it = m[0]
    const t = htmlToText(tag(it, 'title') ?? '')
    const link = (tag(it, 'link') ?? tag(it, 'guid') ?? '').trim()
    const pub = tag(it, 'pubDate')
    const parsed = pub ? new Date(pub) : null
    // WWR puts the location in <region>; Jobicy uses WP Job Manager's <job_listing:location> and <job_listing:company>.
    const region = tag(it, 'region') ?? tag(it, 'job_listing:location')
    const company = tag(it, 'job_listing:company')
    return { title: t, link, postedAt: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined, region: region ? htmlToText(region) : undefined, company: company ? htmlToText(company) : undefined, description: tag(it, 'description') ?? '' }
  })

const rss = (feed: string) =>
  fetchText(feed).pipe(
    Effect.map((xml) =>
      parseRss(xml).map((it): RawJob => {
        // WeWorkRemotely style "Company: Title"
        const [company, title] = it.company ? [it.company, it.title] : it.title.includes(': ') ? [it.title.split(': ')[0], it.title.split(': ').slice(1).join(': ')] : [undefined, it.title]
        return {
          extId: it.link || it.title,
          title: title ?? it.title,
          company,
          location: `${it.region ?? ''} | Remote`.replace(/^ \| /, ''),
          url: it.link,
          applyUrl: it.link,
          postedAt: it.postedAt,
          jd: htmlToText(it.description),
        }
      }),
    ),
  )

/**
 * Hacker News "Ask HN: Who is hiring?" — the newest monthly thread, via the Algolia API.
 * Top-level comments are free text of the form "Company | Role | Location | ...".
 */
const hn = (_board: string) =>
  Effect.gen(function* () {
    const search = obj(
      yield* fetchJson('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=5'),
    )
    const story = arr(search.hits)
      .map(obj)
      .find((h) => /who is hiring/i.test(str(h.title) ?? ''))
    const storyId = story ? str(story.objectID) : undefined
    if (!storyId) return []
    const thread = obj(yield* fetchJson(`https://hn.algolia.com/api/v1/items/${storyId}`))
    return arr(thread.children)
      .map(obj)
      .filter((c) => Predicate.isString(c.text))
      .map((c): RawJob => {
        const text = htmlToText(str(c.text) ?? '')
        const first = text.split('\n')[0] ?? ''
        const parts = first.split('|').map((p) => p.trim())
        const roleish = parts.find((p, i) => i > 0 && /engineer|developer|manager|lead|head|director|cto|staff/i.test(p))
        return {
          extId: str(c.id) ?? '',
          title: (roleish ?? parts[1] ?? first).slice(0, 160),
          company: parts[0]?.slice(0, 80),
          location: parts.filter((p) => /remote|onsite|hybrid|\b[A-Z]{2}\b|york|francisco|usa|us\b/i.test(p)).join(' | ') || 'Unknown',
          url: `https://news.ycombinator.com/item?id=${str(c.id)}`,
          applyUrl: `https://news.ycombinator.com/item?id=${str(c.id)}`,
          postedAt: str(c.created_at),
          jd: text,
        }
      })
  })

export const ADAPTERS = { greenhouse, lever, ashby, workable, smartrecruiters, remoteok, rss, hn } as const
export type AdapterKind = keyof typeof ADAPTERS
export const AGGREGATOR_KINDS: ReadonlySet<string> = new Set(['remoteok', 'rss', 'hn'])
export const isAdapterKind = (k: string): k is AdapterKind => k in ADAPTERS

const URL_PATTERNS: Array<[AdapterKind, RegExp]> = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/],
  ['lever', /jobs\.lever\.co\/([A-Za-z0-9._-]+)/],
  ['ashby', /jobs\.ashbyhq\.com\/([^/?#]+)/],
  ['workable', /apply\.workable\.com\/([A-Za-z0-9_-]+)/],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/],
]

/** Recognize an ATS board from any job/careers URL. */
export const detectAts = (url: string | null | undefined): { kind: AdapterKind; board: string } | null => {
  for (const [kind, re] of URL_PATTERNS) {
    const m = (url ?? '').match(re)
    if (m?.[1] && m[1] !== 'jobs' && m[1] !== 'embed') return { kind, board: decodeURIComponent(m[1]) }
  }
  return null
}

/** Try the common ATSs for a guessed board token (e.g. a company slug). */
export const probeBoard = (token: string) =>
  Effect.gen(function* () {
    for (const kind of ['ashby', 'greenhouse', 'lever', 'workable'] as const) {
      const jobs = yield* ADAPTERS[kind](token).pipe(Effect.option)
      if (jobs._tag === 'Some') return { kind, board: token, jobs: jobs.value }
    }
    return null
  })
