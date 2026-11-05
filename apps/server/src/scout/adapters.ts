import { Duration, Effect, Predicate, Schedule } from 'effect'
import { htmlToText } from '../text'
import { htmlToJd, jdFrom } from '../untrusted'

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

export const fetchText = (url: string, timeoutMs = 25_000, init: { method?: string; body?: string } = {}) =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        ...init,
        headers: { 'User-Agent': UA, Accept: 'application/json, application/rss+xml, */*', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) throw new FetchError(url, res.status, `HTTP ${res.status}`)
      return res.text()
    },
    catch: (e) => (e instanceof FetchError ? e : new FetchError(url, null, e instanceof Error ? e.message : String(e))),
  }).pipe(Effect.retry(retryTransient))

const parseJson = (url: string) => (t: string) =>
  Effect.try({ try: (): unknown => JSON.parse(t), catch: () => new FetchError(url, null, 'invalid JSON') })

export const fetchJson = (url: string) => fetchText(url).pipe(Effect.flatMap(parseJson(url)))

const postJson = (url: string, body: unknown) => fetchText(url, 25_000, { method: 'POST', body: JSON.stringify(body) }).pipe(Effect.flatMap(parseJson(url)))

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
          jd: htmlToJd(str(j.content)),
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
          .map((l) => `${str(obj(l).text) ?? ''}\n${htmlToJd(str(obj(l).content))}`)
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
          jd: [jdFrom(str(j.description), str(j.descriptionPlain)), lists, jdFrom(str(j.additional), str(j.additionalPlain))].filter(Boolean).join('\n\n').trim(),
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
            jd: jdFrom(str(j.descriptionHtml), str(j.descriptionPlain)),
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
            jd: htmlToJd(str(j.description)),
          }
        }),
    ),
  )

/**
 * Read a paged list one page at a time (never in parallel), newest first, up to `maxPages`. Big
 * employers list thousands of jobs; the newest few hundred are what a poll needs.
 */
const paged = <A>(maxPages: number, page: (n: number) => Effect.Effect<{ items: A[]; total: number | null }, FetchError>) =>
  Effect.gen(function* () {
    const out: A[] = []
    // The first page's total counts; Workday reports 0 on later pages.
    let total: number | null = null
    for (let n = 0; n < maxPages; n++) {
      const p = yield* page(n)
      if (n === 0) total = p.total
      out.push(...p.items)
      if (p.items.length === 0 || (total !== null && out.length >= total)) break
    }
    return out
  })

const srLocation = (l: Obj) => {
  const loc = [str(l.city), str(l.region), str(l.country)?.toUpperCase()].filter(Boolean).join(', ')
  return l.remote === true ? `${loc} | Remote` : l.hybrid === true ? `${loc} | Hybrid` : loc
}

const SR_PAGE = 100
const smartrecruiters = (board: string) =>
  paged(3, (n) =>
    fetchJson(`https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=${SR_PAGE}&offset=${n * SR_PAGE}`).pipe(
      Effect.map((d) => ({
        total: Predicate.isNumber(obj(d).totalFound) ? (obj(d).totalFound as number) : null,
        items: arr(obj(d).content)
          .map(obj)
          .map((j): RawJob => {
            const id = str(j.id) ?? ''
            return {
              extId: id,
              title: str(j.name) ?? '',
              company: str(obj(j.company).name),
              location: srLocation(obj(j.location)),
              url: `https://jobs.smartrecruiters.com/${board}/${id}`,
              postedAt: str(j.releasedDate),
              // The list has no description; `smartrecruitersDetail` reads it for postings worth triaging.
              jd: '',
            }
          }),
      })),
    ),
  )

const smartrecruitersDetail = (board: string, job: RawJob) =>
  fetchJson(`https://api.smartrecruiters.com/v1/companies/${board}/postings/${encodeURIComponent(job.extId)}`).pipe(
    Effect.map((raw): Partial<RawJob> => {
      const d = obj(raw)
      const sections = obj(obj(d.jobAd).sections)
      const jd = ['companyDescription', 'jobDescription', 'qualifications', 'additionalInformation']
        .map((k) => {
          const s = obj(sections[k])
          const text = htmlToJd(str(s.text))
          return text ? `${str(s.title) ?? ''}\n${text}`.trim() : ''
        })
        .filter(Boolean)
        .join('\n\n')
      return { jd, url: str(d.postingUrl) ?? job.url, applyUrl: str(d.applyUrl) ?? str(d.postingUrl) ?? job.url, location: srLocation(obj(d.location)) || job.location }
    }),
  )

// Workday: `tenant.wdN/site`, e.g. paypal.wd1/jobs for https://paypal.wd1.myworkdayjobs.com/jobs.
const workdayParts = (board: string) => {
  const m = board.match(/^([A-Za-z0-9_-]+)\.(wd\d+)\/([A-Za-z0-9_-]+)$/)
  if (!m) return null
  const [, tenant, wd, site] = m as unknown as [string, string, string, string]
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`
  return { api: `${host}/wday/cxs/${tenant}/${site}`, site: `${host}/${site}` }
}

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago", "Posted 30+ Days Ago". */
export const workdayPostedAt = (s: string | undefined, now = Date.now()) => {
  if (!s) return undefined
  const days = /today/i.test(s) ? 0 : /yesterday/i.test(s) ? 1 : Number(s.match(/(\d+)\+?\s*days?/i)?.[1] ?? NaN)
  if (Number.isNaN(days)) return undefined
  // "30+" means at least 31.
  return new Date(now - (days + (/\d\+/.test(s) ? 1 : 0)) * 86400_000).toISOString().slice(0, 10)
}

const WORKDAY_PAGE = 20
const workday = (board: string) => {
  const w = workdayParts(board)
  if (!w) return Effect.fail(new FetchError(board, null, 'Workday board should look like tenant.wd5/site'))
  return paged(10, (n) =>
    postJson(`${w.api}/jobs`, { appliedFacets: {}, limit: WORKDAY_PAGE, offset: n * WORKDAY_PAGE, searchText: '' }).pipe(
      Effect.map((d) => ({
        total: Predicate.isNumber(obj(d).total) ? (obj(d).total as number) : null,
        items: arr(obj(d).jobPostings)
          .map(obj)
          .filter((j) => str(j.externalPath))
          .map((j): RawJob => {
            const path = str(j.externalPath)!
            const loc = str(j.locationsText) ?? ''
            return {
              extId: path.split('/').pop() ?? path,
              title: str(j.title) ?? '',
              // "3 Locations" says nothing; the detail read fills in where.
              location: /^\d+ locations?$/i.test(loc.trim()) ? '' : loc,
              url: `${w.site}${path}`,
              applyUrl: `${w.site}${path}/apply`,
              postedAt: workdayPostedAt(str(j.postedOn)),
              // The list has no description; `workdayDetail` reads it for postings worth triaging.
              jd: '',
            }
          }),
      })),
    ),
  )
}

const workdayDetail = (board: string, job: RawJob) => {
  const w = workdayParts(board)
  const path = w && job.url?.startsWith(w.site) ? job.url.slice(w.site.length) : null
  if (!w || !path) return Effect.fail(new FetchError(board, null, 'not a Workday job'))
  return fetchJson(`${w.api}${path}`).pipe(
    Effect.map((raw): Partial<RawJob> => {
      const i = obj(obj(raw).jobPostingInfo)
      const locs = [str(i.location), ...arr(i.additionalLocations).map(str), str(i.remoteType)]
      return { jd: htmlToJd(str(i.jobDescription)), location: joinLocs(locs) || job.location, postedAt: str(i.startDate) ?? job.postedAt }
    }),
  )
}

const recruiteeDate = (s: string | undefined) => (s ? s.replace(' ', 'T').replace(/\s*UTC$/, 'Z') : undefined)

const recruitee = (board: string) =>
  fetchJson(`https://${board}.recruitee.com/api/offers/`).pipe(
    Effect.map((d) =>
      arr(obj(d).offers)
        .map(obj)
        .filter((j) => (str(j.status) ?? 'published') === 'published')
        .map((j): RawJob => {
          const locs = [str(j.location), ...arr(j.locations).map((l) => str(obj(l).name))]
          if (j.remote === true) locs.push('Remote')
          if (j.hybrid === true) locs.push('Hybrid')
          const sal = obj(j.salary)
          return {
            extId: str(j.id) ?? str(j.slug) ?? '',
            title: str(j.title) ?? '',
            company: str(j.company_name),
            location: joinLocs(locs),
            url: str(j.careers_url),
            applyUrl: str(j.careers_apply_url) ?? str(j.careers_url),
            postedAt: recruiteeDate(str(j.published_at) ?? str(j.created_at)),
            jd: [htmlToJd(str(j.description)), htmlToJd(str(j.requirements))].filter(Boolean).join('\n\n'),
            comp: Predicate.isNumber(sal.min) ? `${str(sal.currency) ?? ''} ${sal.min}-${str(sal.max) ?? ''} ${str(sal.period) ?? ''}`.trim() : undefined,
          }
        }),
    ),
  )

/** Gem's job board API has Greenhouse's shape. */
const gem = (board: string) =>
  fetchJson(`https://api.gem.com/job_board/v0/${encodeURIComponent(board)}/job_posts/`).pipe(
    Effect.map((d) =>
      arr(d)
        .map(obj)
        .map((j): RawJob => {
          const type = str(j.location_type)
          const locs = [str(obj(j.location).name), ...arr(j.offices).map((o) => str(obj(obj(o).location).name) ?? str(obj(o).name)), type === 'remote' ? 'Remote' : type === 'hybrid' ? 'Hybrid' : undefined]
          return {
            extId: str(j.id) ?? '',
            title: str(j.title) ?? '',
            location: joinLocs(locs),
            url: str(j.absolute_url),
            applyUrl: str(j.absolute_url),
            postedAt: str(j.first_published_at) ?? str(j.updated_at),
            jd: jdFrom(str(j.content), str(j.content_plain)),
          }
        }),
    ),
  )

const RIPPLING = 'https://api.rippling.com/platform/api/ats/v1/board'
const rippling = (board: string) =>
  fetchJson(`${RIPPLING}/${encodeURIComponent(board)}/jobs`).pipe(
    Effect.map((d) =>
      arr(d)
        .map(obj)
        .map((j): RawJob => ({
          extId: str(j.uuid) ?? '',
          title: (str(j.name) ?? '').trim(),
          location: str(obj(j.workLocation).label) ?? '',
          url: str(j.url),
          applyUrl: str(j.url),
          // The list has no description or date; `ripplingDetail` reads them for postings worth triaging.
          jd: '',
        })),
    ),
  )

const ripplingDetail = (board: string, job: RawJob) =>
  fetchJson(`${RIPPLING}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(job.extId)}`).pipe(
    Effect.map((raw): Partial<RawJob> => {
      const d = obj(raw)
      const desc = obj(d.description)
      return {
        jd: [htmlToJd(str(desc.role)), htmlToJd(str(desc.company))].filter(Boolean).join('\n\n'),
        location: joinLocs(arr(d.workLocations).map(str)) || job.location,
        postedAt: str(d.createdOn),
      }
    }),
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
            jd: htmlToJd(str(j.description)),
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

const remoteLoc = (where: string | undefined) => `${where ?? ''} | Remote`.replace(/^ \| /, '')

/**
 * Job boards that publish JSON instead of RSS: Remotive and Jobicy (`jobs`), Working Nomads (a list,
 * or an Elasticsearch `hits` result), and JSON Feed (`items`). Everything they list is remote.
 */
export const parseJsonFeed = (d: unknown): RawJob[] => {
  const o = obj(d)
  const hits = arr(obj(o.hits).hits).map((h) => obj(h)._source)
  const items = Array.isArray(d) ? d : hits.length ? hits : arr(o.jobs).length ? arr(o.jobs) : arr(o.items)
  return items.map(obj).map((j): RawJob => {
    const url = str(j.url) ?? str(j.absolute_url) ?? str(j.link) ?? str(j.apply_url) ?? ''
    const salMin = j.salaryMin ?? j.annualSalaryMin
    const salMax = j.salaryMax ?? j.annualSalaryMax
    return {
      extId: str(j.id) ?? url,
      title: htmlToText(str(j.title) ?? str(j.jobTitle) ?? str(j.position) ?? ''),
      company: str(j.company_name) ?? str(j.companyName) ?? (Predicate.isString(j.company) ? j.company : str(obj(j.company).name)),
      location: remoteLoc(str(j.candidate_required_location) ?? str(j.jobGeo) ?? str(j.location) ?? (arr(j.locations).map(str).filter(Boolean).join(', ') || undefined)),
      url,
      applyUrl: str(j.apply_url) ?? url,
      postedAt: str(j.publication_date) ?? str(j.pubDate) ?? str(j.pub_date) ?? str(j.date_published),
      jd: htmlToJd(str(j.description) ?? str(j.jobDescription) ?? str(j.content_html) ?? str(j.content_text)),
      comp: str(j.salary) || (salMin !== undefined && salMin !== null ? `${str(j.salaryCurrency) ?? ''} ${str(salMin)}-${str(salMax) ?? ''}`.trim() : undefined),
    }
  })
}

const rss = (feed: string) =>
  fetchText(feed).pipe(
    Effect.flatMap((body) => {
      const text = body.trimStart()
      if (text.startsWith('{') || text.startsWith('[')) return parseJson(feed)(text).pipe(Effect.map(parseJsonFeed))
      const items = parseRss(text).map((it): RawJob => {
        // WeWorkRemotely style "Company: Title"
        const [company, title] = it.company ? [it.company, it.title] : it.title.includes(': ') ? [it.title.split(': ')[0], it.title.split(': ').slice(1).join(': ')] : [undefined, it.title]
        return {
          extId: it.link || it.title,
          title: title ?? it.title,
          company,
          location: remoteLoc(it.region),
          url: it.link,
          applyUrl: it.link,
          postedAt: it.postedAt,
          jd: htmlToJd(it.description),
        }
      })
      // A page that isn't a feed at all would otherwise look like a quiet feed forever.
      if (!items.length && !/<(rss|feed|channel)[\s>]/i.test(text.slice(0, 2000))) return Effect.fail(new FetchError(feed, null, 'not an RSS or JSON job feed'))
      return Effect.succeed(items)
    }),
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
        const text = htmlToJd(str(c.text))
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

export const ADAPTERS = { greenhouse, lever, ashby, workable, smartrecruiters, workday, recruitee, gem, rippling, remoteok, rss, hn } as const
export type AdapterKind = keyof typeof ADAPTERS
export const AGGREGATOR_KINDS: ReadonlySet<string> = new Set(['remoteok', 'rss', 'hn'])
export const isAdapterKind = (k: string): k is AdapterKind => k in ADAPTERS

/**
 * Boards whose list has no descriptions: the scout reads the full posting only for jobs that pass
 * the filters, so triage sees the real description without fetching every job on the board.
 */
export const DETAILS: Partial<Record<AdapterKind, (board: string, job: RawJob) => Effect.Effect<Partial<RawJob>, FetchError>>> = {
  smartrecruiters: smartrecruitersDetail,
  workday: workdayDetail,
  rippling: ripplingDetail,
}

/**
 * The least time between polls, whatever the source's tier. Workday reads up to ten pages, the HN
 * thread is one large download that changes slowly, and Remotive asks for at most four reads a day.
 */
export const minPollMinutes = (kind: string, board: string) =>
  kind === 'workday' || kind === 'hn' ? 60 : kind === 'rss' && /remotive\.com/i.test(board) ? 360 : 0

const URL_PATTERNS: Array<[AdapterKind, RegExp, ((m: RegExpMatchArray) => string)?]> = [
  ['greenhouse', /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/],
  ['lever', /jobs\.lever\.co\/([A-Za-z0-9._-]+)/],
  ['ashby', /jobs\.ashbyhq\.com\/([^/?#]+)/],
  ['workable', /apply\.workable\.com\/([A-Za-z0-9_-]+)/],
  ['smartrecruiters', /(?:jobs|careers)\.smartrecruiters\.com\/([A-Za-z0-9_-]+)/],
  ['workday', /([A-Za-z0-9_-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:wday\/cxs\/[A-Za-z0-9_-]+\/)?(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/, (m) => `${m[1]}.${m[2]}/${m[3]}`],
  ['recruitee', /([A-Za-z0-9-]+)\.recruitee\.com/],
  ['gem', /(?:jobs\.gem\.com|api\.gem\.com\/job_board\/v0)\/([A-Za-z0-9_-]+)/],
  ['rippling', /ats\.rippling\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)\/jobs/],
]

/** Recognize an ATS board from any job/careers URL. */
export const detectAts = (url: string | null | undefined): { kind: AdapterKind; board: string } | null => {
  for (const [kind, re, build] of URL_PATTERNS) {
    const m = (url ?? '').match(re)
    if (m?.[1] && m[1] !== 'jobs' && m[1] !== 'embed' && m[1] !== 'www' && m[1] !== 'api') return { kind, board: build ? build(m) : decodeURIComponent(m[1]) }
  }
  return null
}

/** ATS links in a careers page's HTML, for finding the board behind it. */
export const ATS_LINK = /https?:\/\/(?:(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io|jobs\.(?:lever\.co|ashbyhq\.com|smartrecruiters\.com|gem\.com)|apply\.workable\.com|careers\.smartrecruiters\.com|[A-Za-z0-9_-]+\.wd\d+\.myworkdayjobs\.com|[A-Za-z0-9-]+\.recruitee\.com|ats\.rippling\.com)\/?[^"'\s<>]*/g

/** A job feed the scout can read: the HN hiring thread, RemoteOK, or an RSS/JSON feed URL. */
export const detectFeed = (url: string | null | undefined): { kind: AdapterKind; board: string } | null => {
  const u = (url ?? '').trim()
  if (/news\.ycombinator\.com\/.*whoishiring|hn\.algolia\.com.*whoishiring/i.test(u)) return { kind: 'hn', board: 'whoishiring' }
  if (/^https?:\/\/(www\.)?remoteok\.(com|io)\/?(\?|$)/i.test(u)) return { kind: 'remoteok', board: 'engineer' }
  if (/^https?:\/\//i.test(u) && /rss|feed|atom|\.xml|\.json|\/api\//i.test(u)) return { kind: 'rss', board: u }
  return null
}

/** Any board or feed the scout can poll, recognized from its URL. */
export const detectSource = (url: string | null | undefined) => detectAts(url) ?? detectFeed(url)

/** Try the common ATSs for a guessed board token (e.g. a company slug). */
export const probeBoard = (token: string) =>
  Effect.gen(function* () {
    for (const kind of ['ashby', 'greenhouse', 'lever', 'workable'] as const) {
      const jobs = yield* ADAPTERS[kind](token).pipe(Effect.option)
      if (jobs._tag === 'Some') return { kind, board: token, jobs: jobs.value }
    }
    return null
  })
