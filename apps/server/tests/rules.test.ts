import { describe, expect, test } from 'vitest'
import { checkRules, rulesSummary, type RuleInput, type Rules } from '@sidedoor/shared/rules'

const RULES: Rules = { enabled: true, remoteOnly: true, compFloor: 230_000, targetMin: 400_000, targetMax: 500_000, equityAllowancePct: 15, currency: 'USD', citizenship: 'flag', clearance: 'flag' }
const posting = (o: Partial<RuleInput> = {}): RuleInput => ({ locations: ['Remote - United States'], compTexts: ['$250,000 - $320,000'], jd: 'We are hiring an Engineering Manager to lead our platform team.', ...o })
const check = (o: Partial<RuleInput> = {}, r: Partial<Rules> = {}) => checkRules(posting(o), { ...RULES, ...r }, '2026-10-30T00:00:00Z')
const finding = (c: ReturnType<typeof check>, rule: string) => c.findings.find((f) => f.rule === rule)

describe('remote', () => {
  test('remote in the U.S. passes', () => {
    const c = check({ jd: 'This is a fully remote role open to candidates anywhere in the United States. We meet in person twice a year.' })
    expect(c.result).toBe('pass')
    expect(finding(c, 'remote')).toMatchObject({ outcome: 'pass', reason: 'Listed as remote' })
  })

  test('a hybrid role fails, quoting the posting', () => {
    const c = check({
      locations: ['New York, NY'],
      jd: 'About the role\nThis is a hybrid role: you will work from our New York office three days a week.\nYou will lead a team of 8 engineers.',
    })
    expect(c.result).toBe('fail')
    expect(finding(c, 'remote')).toMatchObject({ outcome: 'fail', quote: 'This is a hybrid role: you will work from our New York office three days a week.' })
  })

  test('a listing marked Hybrid with no remote option fails', () => {
    expect(finding(check({ locations: ['Hybrid remote - Philadelphia metropolitan area'], jd: '' }), 'remote')).toMatchObject({ outcome: 'fail', reason: 'Listed as hybrid or on-site, with no remote option' })
  })

  test('"remote within 50 miles of" an office fails', () => {
    const c = check({ locations: ['Remote - US'], jd: 'This position is remote, but you must live within 50 miles of our Austin, TX office for quarterly onsites.' })
    expect(finding(c, 'remote')).toMatchObject({ outcome: 'fail', reason: 'Must live within a distance of an office', quote: expect.stringContaining('within 50 miles of our Austin') })
  })

  test('relocation fails; "no relocation needed" does not', () => {
    expect(finding(check({ locations: ['San Francisco, CA'], jd: 'Candidates must be willing to relocate to San Francisco.' }), 'remote')?.outcome).toBe('fail')
    expect(finding(check({ jd: 'Fully remote. No relocation required.' }), 'remote')?.outcome).toBe('pass')
  })

  test('a listing that offers both remote and hybrid is flagged, not failed', () => {
    expect(finding(check({ locations: ['San Francisco HQ | Remote | Hybrid'] }), 'remote')?.outcome).toBe('flag')
    expect(finding(check({ locations: ['Remote, US'], jd: 'Our Approach to Hybrid Working\nWe embrace a hybrid work model.' }), 'remote')?.outcome).toBe('flag')
  })

  test("hybrid cloud, optional offices and an EEO line don't count as office time", () => {
    const c = check({ jd: 'You will design hybrid cloud deployments. Our SF office is optional for those who like it. Read more at https://example.com/hybrid-workplace-strategy.' })
    expect(finding(c, 'remote')?.outcome).toBe('pass')
  })

  test('a city with no word on remote is flagged; no location at all is unknown', () => {
    expect(finding(check({ locations: ['Chicago, IL'] }), 'remote')?.outcome).toBe('flag')
    expect(finding(check({ locations: [], jd: '' }), 'remote')?.outcome).toBe('unknown')
  })

  test('not checked when the user takes hybrid roles', () => {
    expect(finding(check({ locations: ['Hybrid - NYC'] }, { remoteOnly: false }), 'remote')).toBeUndefined()
  })
})

describe('pay', () => {
  test('pay below the floor fails', () => {
    const c = check({ compTexts: ['$140,000 - $190,000'] })
    expect(c.result).toBe('fail')
    expect(finding(c, 'pay')).toMatchObject({ outcome: 'fail', reason: 'Base tops out at $190K, under your $230K floor; no equity or bonus mentioned', quote: '$140,000 - $190,000' })
    expect(c.band).toBe('below-floor')
  })

  test('no pay in the posting is unknown, not a fail', () => {
    const c = check({ compTexts: ['Not published'] })
    expect(finding(c, 'pay')).toMatchObject({ outcome: 'unknown', reason: 'No pay range in the posting' })
    expect(c.result).toBe('pass')
    expect(c.pay).toBeNull()
  })

  test('equity or a bonus can carry a base just under the floor to a flag; far under still fails', () => {
    expect(finding(check({ compTexts: ['$163,000-$226,000 USD'], jd: 'Competitive salary plus equity.' }), 'pay')?.outcome).toBe('flag')
    expect(finding(check({ compTexts: ['$170,000 base plus cash bonus and equity'] }), 'pay')?.outcome).toBe('fail')
    expect(finding(check({ compTexts: ['$163,000-$226,000 USD'], jd: 'Competitive salary plus equity.' }, { equityAllowancePct: 0 }), 'pay')?.outcome).toBe('fail')
  })

  test('total comp (OTE) under the floor fails even with equity', () => {
    expect(finding(check({ compTexts: ['$200K – $225K OTE + equity'] }), 'pay')).toMatchObject({ outcome: 'fail', reason: 'Total comp tops out at $225K, under your $230K floor' })
  })

  test('several ranges: the most generous one counts', () => {
    const c = check({ compTexts: ['$230,000-$290,000 (NJ); $204,000-$264,000 elsewhere'] })
    expect(c.pay).toMatchObject({ min: 204_000, max: 290_000, basis: 'base' })
    expect(finding(c, 'pay')).toMatchObject({ outcome: 'pass', reason: 'Base up to $290K, under your target (target $400K–$500K)' })
    expect(c.band).toBe('under-target')
  })

  test('reads the formats boards use, and places the band', () => {
    expect(check({ compTexts: ['$208.6–429.5K base plus equity'] }).pay).toMatchObject({ min: 208_600, max: 429_500 })
    expect(check({ compTexts: ['USD 218000-265000 per-year-salary'] }).pay).toMatchObject({ min: 218_000, max: 265_000 })
    expect(check({ compTexts: ['$890K – $1.69M'] }).band).toBe('above-target')
    expect(check({ compTexts: ['$110 - $125/hr'] }).pay?.max).toBe(260_000)
    expect(check({ compTexts: [], compMin: 420_000, compMax: 480_000 }).band).toBe('target')
  })

  test('pay only in the description is found there', () => {
    const c = check({ compTexts: [], jd: 'We raised $50M last year.\nThe base salary range for this role is $180,000 to $210,000.' })
    expect(finding(c, 'pay')).toMatchObject({ outcome: 'fail', quote: 'The base salary range for this role is $180,000 to $210,000.' })
  })

  test('"starting at" with no top, and pay in another currency, are not fails', () => {
    expect(finding(check({ compTexts: ['Starting at $200,000 base'] }), 'pay')?.outcome).toBe('flag')
    expect(finding(check({ compTexts: ['CA$180K – CA$220K'] }), 'pay')).toMatchObject({ outcome: 'unknown', reason: 'Pay is in CAD, not compared with your USD figures' })
  })
})

describe('citizenship and clearance', () => {
  test('a U.S. citizenship requirement is flagged with the quote', () => {
    const c = check({ jd: 'Requirements\nDue to government contracts, candidates must be U.S. citizens or lawful permanent residents.\nGreat benefits.' })
    expect(c.result).toBe('flag')
    expect(finding(c, 'citizenship')).toMatchObject({ outcome: 'flag', quote: 'Due to government contracts, candidates must be U.S. citizens or lawful permanent residents.' })
  })

  test('export control and clearance asks, including in form questions', () => {
    expect(finding(check({ jd: 'This role requires access to ITAR-controlled data; applicants must be a U.S. person.' }), 'citizenship')?.outcome).toBe('flag')
    expect(finding(check({ questions: ['Do you hold an active security clearance?'] }), 'clearance')).toMatchObject({ outcome: 'flag', quote: 'Do you hold an active security clearance?' })
    expect(finding(check({ questions: ['Are you a US citizen?'] }, { citizenship: 'fail' }), 'citizenship')?.outcome).toBe('fail')
  })

  test('equal-opportunity boilerplate and visa sponsorship are not citizenship asks', () => {
    const c = check({ jd: 'We are an equal opportunity employer and do not discriminate on the basis of race, national origin, or U.S. citizenship status.\nWe sponsor green cards for eligible employees.' })
    expect(finding(c, 'citizenship')?.outcome).toBe('pass')
    expect(c.result).toBe('pass')
  })

  test('ignored when the user says so', () => {
    expect(finding(check({ jd: 'Must be a U.S. citizen.' }, { citizenship: 'ignore' }), 'citizenship')).toBeUndefined()
  })
})

test('the summary line names what failed', () => {
  const c = check({ locations: ['Hybrid - New York, NY'], compTexts: ['$140,000 - $190,000'], jd: '' })
  expect(rulesSummary(c)).toBe('fail: Listed as hybrid or on-site, with no remote option; Base tops out at $190K, under your $230K floor; no equity or bonus mentioned')
})
