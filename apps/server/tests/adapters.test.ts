import { Effect } from 'effect'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ADAPTERS, DETAILS, detectAts, detectFeed, minPollMinutes, parseJsonFeed, portfolioBoard, workdayPostedAt } from '../src/scout/adapters'

/** Canned responses by URL; a function gets the request body (Workday POSTs its page). */
let routes: Record<string, unknown | ((body: unknown) => unknown)> = {}
const calls: Array<{ url: string; method: string; body: unknown }> = []

beforeEach(() => {
  routes = {}
  calls.length = 0
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, method: init.method ?? 'GET', body })
    if (!(url in routes)) return new Response('not found', { status: 404 })
    const r = routes[url]
    const out = typeof r === 'function' ? r(body) : r
    return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status: 200 })
  })
})
afterEach(() => vi.unstubAllGlobals())

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e)

describe('recognizing boards and feeds', () => {
  test('Workday, Recruitee, Gem and Rippling URLs', () => {
    expect(detectAts('https://paypal.wd1.myworkdayjobs.com/jobs')).toEqual({ kind: 'workday', board: 'paypal.wd1/jobs' })
    expect(detectAts('https://capitalone.wd12.myworkdayjobs.com/en-US/Capital_One/job/McLean-VA/Director_R1')).toEqual({ kind: 'workday', board: 'capitalone.wd12/Capital_One' })
    expect(detectAts('https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs/jobs')).toEqual({ kind: 'workday', board: 'paypal.wd1/jobs' })
    expect(detectAts('https://bunq.recruitee.com/o/support-lead')).toEqual({ kind: 'recruitee', board: 'bunq' })
    expect(detectAts('https://jobs.gem.com/acme/4965519002')).toEqual({ kind: 'gem', board: 'acme' })
    expect(detectAts('https://ats.rippling.com/en-GB/rippling/jobs/ef0b7266')).toEqual({ kind: 'rippling', board: 'rippling' })
    expect(detectAts('https://www.recruitee.com/')).toBeNull()
  })

  test('feeds: the HN hiring thread, RemoteOK, and RSS or JSON feed URLs', () => {
    expect(detectFeed('https://news.ycombinator.com/submitted?id=whoishiring')).toEqual({ kind: 'hn', board: 'whoishiring' })
    expect(detectFeed('https://remoteok.com/')).toEqual({ kind: 'remoteok', board: 'engineer' })
    expect(detectFeed('https://remotive.com/api/remote-jobs?category=software-dev')).toMatchObject({ kind: 'rss' })
    expect(detectFeed('https://acme.com/careers')).toBeNull()
  })

  test('slow or rate-limited sources are polled less often', () => {
    expect(minPollMinutes('workday', 'paypal.wd1/jobs')).toBe(60)
    expect(minPollMinutes('rss', 'https://remotive.com/api/remote-jobs')).toBe(360)
    expect(minPollMinutes('greenhouse', 'stripe')).toBe(0)
  })
})

describe('Workday', () => {
  const api = 'https://paypal.wd1.myworkdayjobs.com/wday/cxs/paypal/jobs'
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ title: `Engineering Manager ${i}`, externalPath: `/job/Remote-USA/Engineering-Manager_R${i}`, locationsText: i === 0 ? '3 Locations' : 'Remote, United States of America', postedOn: 'Posted 3 Days Ago' }))

  test('reads pages one at a time until it has them all, newest first', async () => {
    // Like Workday, only the first page carries the total.
    routes[`${api}/jobs`] = (b: unknown) => {
      const { offset } = b as { offset: number }
      return offset === 0 ? { total: 25, jobPostings: page(20) } : { total: 0, jobPostings: page(5).map((j, i) => ({ ...j, externalPath: `/job/x/Second_${i}` })) }
    }
    const jobs = await run(ADAPTERS.workday('paypal.wd1/jobs'))
    expect(jobs).toHaveLength(25)
    expect(calls.map((c) => [c.method, (c.body as { offset: number }).offset])).toEqual([['POST', 0], ['POST', 20]])
    expect(jobs[0]).toMatchObject({ extId: 'Engineering-Manager_R0', location: '', url: 'https://paypal.wd1.myworkdayjobs.com/jobs/job/Remote-USA/Engineering-Manager_R0', jd: '' })
    expect(jobs[1]!.location).toBe('Remote, United States of America')
  })

  test('the detail read fills in the description, every location and the start date', async () => {
    routes[`${api}/job/Remote-USA/Engineering-Manager_R0`] = { jobPostingInfo: { jobDescription: '<p>Lead the <b>payments</b> team.</p>', location: 'San Jose, CA', additionalLocations: ['Remote, US'], startDate: '2026-10-20' } }
    const d = await run(DETAILS.workday!('paypal.wd1/jobs', { extId: 'x', title: 't', location: '', url: 'https://paypal.wd1.myworkdayjobs.com/jobs/job/Remote-USA/Engineering-Manager_R0', jd: '' }))
    expect(d).toMatchObject({ location: 'San Jose, CA | Remote, US', postedAt: '2026-10-20' })
    expect(d.jd).toContain('Lead the payments team.')
  })

  test('"Posted N Days Ago" becomes a date', () => {
    const now = Date.parse('2026-10-28T12:00:00Z')
    expect(workdayPostedAt('Posted Today', now)).toBe('2026-10-28')
    expect(workdayPostedAt('Posted Yesterday', now)).toBe('2026-10-27')
    expect(workdayPostedAt('Posted 8 Days Ago', now)).toBe('2026-10-20')
    expect(workdayPostedAt('Posted 30+ Days Ago', now)).toBe('2026-09-27')
    expect(workdayPostedAt('Hiring now', now)).toBeUndefined()
  })
})

describe('other company boards', () => {
  test('SmartRecruiters: list, then the job ad for the description', async () => {
    routes['https://api.smartrecruiters.com/v1/companies/Acme/postings?limit=100&offset=0'] = { totalFound: 1, content: [{ id: '74400', name: 'Director of Engineering', company: { name: 'Acme' }, releasedDate: '2026-10-27T10:00:00Z', location: { city: 'Austin', region: 'TX', country: 'us', remote: true } }] }
    routes['https://api.smartrecruiters.com/v1/companies/Acme/postings/74400'] = { postingUrl: 'https://jobs.smartrecruiters.com/Acme/74400-director', applyUrl: 'https://jobs.smartrecruiters.com/Acme/74400-director?oga=true', location: { city: 'Austin', country: 'us', remote: true }, jobAd: { sections: { jobDescription: { title: 'The role', text: '<p>Run three teams.</p>' }, qualifications: { title: 'You', text: '<ul><li>10 years</li></ul>' } } } }
    const [job] = await run(ADAPTERS.smartrecruiters('Acme'))
    expect(job).toMatchObject({ extId: '74400', title: 'Director of Engineering', location: 'Austin, TX, US | Remote', jd: '' })
    const d = await run(DETAILS.smartrecruiters!('Acme', job!))
    expect(d.jd).toContain('Run three teams.')
    expect(d.jd).toContain('10 years')
    expect(d.applyUrl).toBe('https://jobs.smartrecruiters.com/Acme/74400-director?oga=true')
  })

  test('Recruitee', async () => {
    routes['https://acme.recruitee.com/api/offers/'] = { offers: [{ id: 2798695, title: 'Engineering Lead', status: 'published', location: 'Remote', locations: [{ name: 'New York' }], remote: true, careers_url: 'https://acme.recruitee.com/o/lead', careers_apply_url: 'https://acme.recruitee.com/o/lead/c/new', published_at: '2026-10-27 12:11:34 UTC', description: '<p>About</p>', requirements: '<p>Needs</p>', salary: { min: 200000, max: 250000, currency: 'USD', period: 'year' } }, { id: 1, title: 'Old', status: 'closed' }] }
    const jobs = await run(ADAPTERS.recruitee('acme'))
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ extId: '2798695', location: 'Remote | New York', postedAt: '2026-10-27T12:11:34Z', applyUrl: 'https://acme.recruitee.com/o/lead/c/new', comp: 'USD 200000-250000 year' })
    expect(jobs[0]!.jd).toBe('About\n\nNeeds')
  })

  test('Gem', async () => {
    routes['https://api.gem.com/job_board/v0/acme/job_posts/'] = [{ id: '49655', title: 'Staff Engineer', absolute_url: 'https://jobs.gem.com/acme/49655', content_plain: 'Build it.', location: { name: 'San Francisco' }, location_type: 'remote', first_published_at: '2026-10-01T00:00:00Z' }]
    const [job] = await run(ADAPTERS.gem('acme'))
    expect(job).toMatchObject({ extId: '49655', location: 'San Francisco | Remote', jd: 'Build it.', postedAt: '2026-10-01T00:00:00Z' })
  })

  test('Rippling: list, then the job for its description and date', async () => {
    const base = 'https://api.rippling.com/platform/api/ats/v1/board/acme/jobs'
    routes[base] = [{ uuid: 'ef0b', name: ' Head of Engineering ', url: 'https://ats.rippling.com/acme/jobs/ef0b', workLocation: { label: 'Remote (US)' } }]
    routes[`${base}/ef0b`] = { description: { company: '<p>We make things.</p>', role: '<p>Lead engineering.</p>' }, workLocations: ['Remote (US)', 'New York, NY'], createdOn: '2026-10-06T16:36:07-07:00' }
    const [job] = await run(ADAPTERS.rippling('acme'))
    expect(job).toMatchObject({ extId: 'ef0b', title: 'Head of Engineering', location: 'Remote (US)', jd: '' })
    expect(await run(DETAILS.rippling!('acme', job!))).toMatchObject({ jd: 'Lead engineering.\n\nWe make things.', location: 'Remote (US) | New York, NY', postedAt: '2026-10-06T16:36:07-07:00' })
  })
})

describe('VC portfolio boards', () => {
  const nextData = (props: unknown) => `<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: props } })}</script></html>`

  test('Getro: the page names the collection; the search API pages through the whole board', async () => {
    routes['https://jobs.fund.test/jobs'] = nextData({ network: { id: '636' } })
    const getroJob = (id: number) => ({ id, title: `Engineering Manager ${id}`, organization: { name: 'Acme', slug: 'acme-2' }, slug: `${id}-engineering-manager`, locations: ['New York, NY, USA'], work_mode: id === 1 ? 'remote' : 'on_site', url: 'https://job-boards.greenhouse.io/acme/jobs/9', created_at: 1794153106, compensation_amount_min_cents: id === 1 ? 20000000 : null, compensation_amount_max_cents: id === 1 ? 25000000 : null, compensation_currency: 'USD', compensation_period: 'year' })
    routes['https://api.getro.com/api/v2/collections/636/search/jobs'] = (b: unknown) => {
      const { page } = b as { page: number }
      return { results: { count: 1001, jobs: page === 0 ? Array.from({ length: 1000 }, (_, i) => getroJob(i + 1)) : [getroJob(1001)] } }
    }
    const jobs = await run(ADAPTERS.getro('jobs.fund.test'))
    expect(jobs).toHaveLength(1001)
    expect(calls.filter((c) => c.method === 'POST').map((c) => (c.body as { page: number }).page)).toEqual([0, 1])
    expect(jobs[0]).toMatchObject({ extId: '1', company: 'Acme', location: 'New York, NY, USA | Remote', url: 'https://jobs.fund.test/companies/acme-2/jobs/1-engineering-manager', applyUrl: 'https://job-boards.greenhouse.io/acme/jobs/9', postedAt: '2026-11-08T15:51:46.000Z', comp: 'USD 200000-250000 year', jd: '' })
    expect(jobs[1]!.location).toBe('New York, NY, USA')

    routes['https://jobs.fund.test/companies/acme-2/jobs/1-engineering-manager'] = nextData({ initialState: { jobs: { currentJob: { description: '<p>Lead the team.</p>' } } } })
    expect(await run(DETAILS.getro!('jobs.fund.test', jobs[0]!))).toEqual({ jd: 'Lead the team.' })
  })

  test('Consider: the board page gives the board id and CSRF token; the search pages by cursor', async () => {
    routes['https://jobs.vc.test/jobs'] = '<script>window.serverInitialData = {"csrfToken":"tok","board":{"id":"vc-fund","isParent":true}}</script>'
    routes['https://jobs.vc.test/api-boards/search-jobs'] = {
      total: 1,
      meta: { size: 500, sequence: 'abc' },
      jobs: [{ jobId: 'j1', title: 'Staff Engineer', companyName: 'Acme', locations: ['United States'], remote: true, hybrid: false, url: 'https://jobs.ashbyhq.com/acme/j1', applyUrl: 'https://jobs.ashbyhq.com/acme/j1?utm_source=vc', timeStamp: '2026-11-08T00:00:00Z', salary: { minValue: 180000, maxValue: 220000, currency: { value: 'USD' }, period: { value: 'year' } } }],
    }
    const jobs = await run(ADAPTERS.consider('jobs.vc.test'))
    expect(jobs).toEqual([{ extId: 'j1', title: 'Staff Engineer', company: 'Acme', location: 'United States | Remote', url: 'https://jobs.ashbyhq.com/acme/j1', applyUrl: 'https://jobs.ashbyhq.com/acme/j1?utm_source=vc', postedAt: '2026-11-08T00:00:00Z', jd: '', comp: 'USD 180000-220000 year' }])
    expect(calls.at(-1)?.body).toMatchObject({ board: { id: 'vc-fund', isParent: true }, meta: { size: 500 } })
  })

  test('recognized from the board URL, whatever page it points at', async () => {
    routes['https://jobs.fund.test/jobs'] = nextData({ network: { id: '636' } })
    routes['https://jobs.vc.test/jobs'] = '<script>window.serverInitialData = {"csrfToken":"tok","board":{"id":"vc-fund","isParent":true}}</script>'
    routes['https://acme.test/jobs'] = '<html>Careers</html>'
    expect(await run(portfolioBoard('https://jobs.fund.test/companies'))).toEqual({ kind: 'getro', board: 'jobs.fund.test' })
    expect(await run(portfolioBoard('jobs.vc.test'))).toEqual({ kind: 'consider', board: 'jobs.vc.test' })
    expect(await run(portfolioBoard('https://acme.test/careers'))).toBeNull()
  })
})

describe('job feeds', () => {
  test('JSON feeds read as remote listings with their company and region', () => {
    const remotive = parseJsonFeed({ jobs: [{ id: 1, url: 'https://remotive.com/remote-jobs/x-1', title: 'Head of Engineering', company_name: 'Citrusco', candidate_required_location: 'USA', publication_date: '2026-10-26T12:20:09', description: '<p>JD</p>', salary: '' }] })
    expect(remotive[0]).toMatchObject({ extId: '1', title: 'Head of Engineering', company: 'Citrusco', location: 'USA | Remote', postedAt: '2026-10-26T12:20:09', jd: 'JD', comp: undefined })
    const jobicy = parseJsonFeed({ jobs: [{ id: 157680, url: 'https://jobicy.com/jobs/157680', jobTitle: 'Staff Software Engineer', companyName: 'Imageco', jobGeo: 'Canada, USA', pubDate: '2026-10-28T16:55:29+00:00', jobDescription: '<p>JD</p>', salaryMin: 205000, salaryMax: 231000, salaryCurrency: 'USD' }] })
    expect(jobicy[0]).toMatchObject({ title: 'Staff Software Engineer', company: 'Imageco', location: 'Canada, USA | Remote', comp: 'USD 205000-231000' })
    const nomads = parseJsonFeed({ hits: { hits: [{ _source: { id: 191, title: 'Principal Engineer', company: 'G-P', locations: ['USA'], pub_date: '2026-10-28T10:06:33-04:00', apply_url: 'https://job-boards.greenhouse.io/gp/jobs/1', description: '<p>JD</p>' } }] } })
    expect(nomads[0]).toMatchObject({ extId: '191', company: 'G-P', location: 'USA | Remote', url: 'https://job-boards.greenhouse.io/gp/jobs/1' })
    expect(parseJsonFeed([{ url: 'https://www.workingnomads.com/job/go/1/', title: 'Senior Back-end Developer', company_name: 'Citrusco', location: 'Europe, USA' }])[0]).toMatchObject({ location: 'Europe, USA | Remote' })
    // A fund's jobs file says how each job is worked; an on-site one isn't made remote.
    const fund = parseJsonFeed({ jobs: [{ id: '0x::b3', company: '0x', title: 'Engineering Manager', location: 'New York, NY', work_type: 'On-site', apply_url: 'https://jobs.ashbyhq.com/0x/b3', first_seen: '2026-11-02T13:01:38+00:00' }] })
    expect(fund[0]).toMatchObject({ company: '0x', location: 'New York, NY | On-site', url: 'https://jobs.ashbyhq.com/0x/b3', postedAt: '2026-11-02T13:01:38+00:00' })
  })

  test('a JSON feed URL saved as rss is read, and a page that is no feed is an error, not an empty feed', async () => {
    routes['https://remotive.com/api/remote-jobs?category=software-dev'] = { jobs: [{ id: 7, url: 'https://remotive.com/remote-jobs/7', title: 'Engineering Manager', company_name: 'Acme', candidate_required_location: 'Worldwide' }] }
    routes['https://acme.com/careers'] = '<html><body>Careers</body></html>'
    routes['https://acme.com/empty.rss'] = '<?xml version="1.0"?><rss><channel><title>Jobs</title></channel></rss>'
    expect(await run(ADAPTERS.rss('https://remotive.com/api/remote-jobs?category=software-dev'))).toMatchObject([{ title: 'Engineering Manager', company: 'Acme' }])
    await expect(run(ADAPTERS.rss('https://acme.com/careers'))).rejects.toThrow('not an RSS or JSON job feed')
    expect(await run(ADAPTERS.rss('https://acme.com/empty.rss'))).toEqual([])
  })
})
