// The user's hard rules for a role (fully remote, a pay floor, citizenship or clearance asks),
// checked in code against the posting before prep and again before submit. Pure: the server stores
// the result on the application (services/rules.ts); the application page and agents read it.

export type RuleOutcome = 'pass' | 'flag' | 'fail' | 'unknown'
export type RuleResult = 'pass' | 'flag' | 'fail'
export type RuleName = 'remote' | 'pay' | 'citizenship' | 'clearance'
/** What a citizenship or clearance ask does: flag it, block the role, or let it through. */
export type AskRule = 'flag' | 'fail' | 'ignore'

export type Rules = {
  enabled: boolean
  /** Fully remote only: hybrid, on-site, relocation and "within N miles of" fail. */
  remoteOnly: boolean
  /** Total comp floor (yearly, in `currency`). Roles clearly under it fail. */
  compFloor: number | null
  /** Target total comp band; reported, so higher-paying roles can go first. */
  targetMin: number | null
  targetMax: number | null
  /** How much equity and bonus may add on top of a posted base, as a percent of it. */
  equityAllowancePct: number
  currency: string
  citizenship: AskRule
  clearance: AskRule
}

export type RuleFinding = {
  rule: RuleName
  outcome: RuleOutcome
  reason: string
  /** The posting's own words behind it. */
  quote: string | null
}

export type PayBand = 'below-floor' | 'under-target' | 'target' | 'above-target'

export type RuleCheck = {
  at: string
  result: RuleResult
  findings: RuleFinding[]
  /** Yearly pay read from the posting; null when it posts none. */
  pay: { min: number | null; max: number | null; basis: 'base' | 'total'; currency: string; extras: boolean } | null
  band: PayBand | null
  /** Set when someone chose to go ahead despite a fail. Covers only the rules that failed then. */
  override?: { at: string; by: string; note: string | null; rules: RuleName[] } | null
}

/** The fails nobody has overridden: these stop prep and submit. */
export const blockingFindings = (c: RuleCheck | null | undefined) =>
  c ? c.findings.filter((f) => f.outcome === 'fail' && !c.override?.rules.includes(f.rule)) : []

/** What the check reads: the posting's and application's fields. */
export type RuleInput = {
  locations: (string | null | undefined)[]
  compTexts: (string | null | undefined)[]
  compMin?: number | null
  compMax?: number | null
  jd?: string | null
  /** Triage's verdict on where the user can work from ('no' = not eligible). */
  locationFit?: string | null
  locationNote?: string | null
  /** The application form's questions, when known: citizenship and clearance asks often live there. */
  questions?: string[]
}

const RANK: Record<RuleOutcome, number> = { unknown: 0, pass: 0, flag: 1, fail: 2 }

/** The user's pay figures, short: 230000 → "$230K". */
export const money = (n: number, currency = 'USD') => {
  const sym = currency === 'USD' ? '$' : `${currency} `
  return n >= 1_000_000 ? `${sym}${+(n / 1_000_000).toFixed(2)}M` : `${sym}${Math.round(n / 1000)}K`
}

// ---- text helpers ----------------------------------------------------------------------------------

/** Sentences and lines of a posting, without markdown bullets. */
const sentences = (text: string) =>
  text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z(•*\-–])/)
    .map((s) => s.replace(/^[\s>*•\-–#]+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

/** The sentence around a match, cut to a readable length. */
const quoteOf = (s: string, re: RegExp) => {
  if (s.length <= 240) return s
  const i = Math.max(0, s.search(re))
  const from = Math.max(0, i - 100)
  return `${from ? '…' : ''}${s.slice(from, from + 220).trim()}${from + 220 < s.length ? '…' : ''}`
}

const find = (texts: string[], re: RegExp, skip?: (s: string) => boolean) => {
  for (const t of texts) for (const s of sentences(t)) if (re.test(s) && !skip?.(s)) return quoteOf(s, re)
  return null
}

// ---- remote ----------------------------------------------------------------------------------------

const REMOTE_WORD = /\bremote\b|\bdistributed\b|\banywhere\b|work from home|\bwfh\b/i
const NOT_REMOTE = /\b(?:not|isn['’]t|non)[- ](?:a\s+)?(?:fully\s+)?remote\b(?![- ](?:only|first))|\bremote (?:work )?(?:is )?not (?:available|possible|an option|offered)\b/i
const MILES = /\bwithin\s+(?:a\s+)?(?:\d+[\s-]*(?:miles?\b|mi\b|km\b|kilomet(?:er|re)s?\b|(?:minutes?|hours?|hrs?)\s+(?:drive|commute|of\s+(?:our|the|an?|one of)\b))|(?:a\s+)?(?:reasonable\s+)?(?:commut\w*|driving)\s+distance)|\bcommut(?:able|ing)\s+distance\b|\bmust\s+(?:live|reside|be\s+(?:located|based))\s+(?:with)?in\s+(?:the\s+)?(?:\w+\s+){0,3}(?:metro(?:politan)?|area|region)\b/i
/** Office time the company talks about in general ("our hybrid work model"). */
const HYBRID = /\bhybrid\s*(?:[(:\-–]\s*)?(?:role|position|job|schedule|work(?:ing|place)?\b|model|arrangement|policy|opportunity|set-?up|in\b|from\b|out of\b|based\b|\d|one|two|three|four)|\b(?:is|be|are)\s+(?:a\s+)?hybrid\b/i
/** Office time this role requires: a schedule, or "this role is hybrid / on-site". */
const ONSITE = new RegExp(
  [
    /\b(?:\d|one|two|three|four|five)\s*\+?\s*(?:or more\s+)?days?\s*(?:a|per|each|every|\/)\s*week\s*(?:in|at|from|into)\s+(?:the|our|an?|one of our)?\s*(?:[\w,.-]+\s+){0,3}(?:office|hub|hq|headquarters|campus)/.source,
    /\b(?:in|at) (?:the|our) (?:[\w-]+\s+){0,2}office\s+(?:\d|one|two|three|four|five)\s*\+?\s*days/.source,
    /\b(?:this|the) (?:role|position|job) is (?:based )?(?:on-?site|in[- ]office|in[- ]person|office[- ]based)/.source,
    /\b(?:fully|100%)\s+(?:on-?site|in[- ]office|in[- ]person)/.source,
    /\b(?:on-?site|in[- ]office|office[- ]based)\s+(?:role|position|job|presence|requirement|schedule|work)\b/.source,
    /\b(?:must|required to|expected to|need to)\s+(?:be\s+)?(?:work(?:ing)?\s+)?(?:on-?site|in[- ]office|in (?:the|our) office|in[- ]person)\b/.source,
    /\breturn[- ]to[- ]office\b/.source,
    /\b(?:this|the) (?:role|position|job) is (?:a\s+)?hybrid\b/.source,
    /\bhybrid\s*[(:,\-–]?\s*(?:\d|one|two|three|four)\s*\+?\s*days?\b/.source,
  ].join('|'),
  'i',
)
const RELOCATE = /\b(?:must|will need to|required to|willing(?:ness)? to|able to|need to|expected to)\s+relocate\b|\brelocation\s+(?:to\s+[\w ,]+?\s+)?(?:is\s+)?(?:required|necessary|mandatory|expected)\b/i
const NO_RELOCATE = /\bno relocation\b|\bno need to relocate\b|\b(?:don['’]t|do not|won['’]t|will not) (?:need|have) to relocate\b|\brelocation (?:is )?not (?:required|necessary)\b|\bnot (?:required|necessary) to relocate\b|\bwithout (?:needing to )?relocat/i
/** Office time offered, not required. */
/** Office time wished for, not required: a flag at most. */
const PREFER = /\bprefer(?:red|ence|s)?\b|\bencourag\w*\b|\bideally\b/i
const OPTIONAL = /\boptional\b|\bif you (?:'d |would )?(?:like|prefer|want|choose)\b|\bwelcome to\b|\bcan choose\b|\bfor those (?:who|near|living)\b|\bnot required\b/i
/** Location-field parts that mean office time. */
const OFFICE_PART = /\bhybrid\b|\bon-?site\b|\bin[- ]office\b|\boffice[- ]based\b|^office$/i

const checkRemote = (input: RuleInput, texts: string[]): RuleFinding => {
  const locs = input.locations.filter((l): l is string => !!l?.trim())
  const parts = locs.flatMap((l) => l.split(/\s*(?:[|;,•(){}]|\bor\b|\band\b|\/)\s*/i)).map((p) => p.trim()).filter(Boolean)
  const officeParts = parts.filter((p) => OFFICE_PART.test(p))
  const remoteParts = parts.filter((p) => !OFFICE_PART.test(p) && REMOTE_WORD.test(p) && !NOT_REMOTE.test(p))
  const all = [...locs, ...texts]

  // Fails wherever they appear: not remote, a radius around an office, relocation.
  const notRemote = find(all, NOT_REMOTE)
  if (notRemote) return { rule: 'remote', outcome: 'fail', reason: 'Says it is not remote', quote: notRemote }
  const radius = find(all, MILES)
  if (radius) return { rule: 'remote', outcome: 'fail', reason: 'Must live within a distance of an office', quote: radius }
  const relocate = find(all, RELOCATE, (s) => NO_RELOCATE.test(s))
  if (relocate) return { rule: 'remote', outcome: 'fail', reason: 'Asks you to relocate', quote: relocate }
  if (officeParts.length && !remoteParts.length) return { rule: 'remote', outcome: 'fail', reason: 'Listed as hybrid or on-site, with no remote option', quote: locs.join(' · ') }
  // A schedule this role requires fails, unless the same sentence offers remote, prefers it or calls it optional.
  const both = (s: string) => /\bremote(?:ly)?\b/i.test(s) && /\bor\b|\beither\b|\bflexib/i.test(s)
  const strict = find(texts, ONSITE, (s) => OPTIONAL.test(s) || PREFER.test(s) || both(s))
  if (strict) return { rule: 'remote', outcome: 'fail', reason: 'The description asks for office time', quote: strict }
  // Talk of a hybrid culture fails a listing that never says remote, and flags one that does.
  const general = find(texts, HYBRID, (s) => OPTIONAL.test(s) || PREFER.test(s) || both(s))
  if (general && !remoteParts.length) return { rule: 'remote', outcome: 'fail', reason: 'The description describes hybrid work, and the listing never says remote', quote: general }
  if (officeParts.length) return { rule: 'remote', outcome: 'flag', reason: 'Listed as both remote and hybrid or on-site; check which this role is', quote: locs.join(' · ') }
  const mixed = general ?? find(texts, new RegExp(`${HYBRID.source}|${ONSITE.source}`, 'i'), (s) => OPTIONAL.test(s))
  if (mixed) return { rule: 'remote', outcome: 'flag', reason: 'Listed as remote, but the description mentions office time; check it', quote: mixed }
  if (input.locationFit === 'no') return { rule: 'remote', outcome: 'flag', reason: `Triage thinks you can't work it from where you are${input.locationNote ? `: ${input.locationNote}` : ''}`, quote: locs.join(' · ') || null }
  if (remoteParts.length) return { rule: 'remote', outcome: 'pass', reason: 'Listed as remote', quote: locs.join(' · ') }
  const remoteJd = find(texts, REMOTE_WORD, (s) => NOT_REMOTE.test(s))
  if (remoteJd) return { rule: 'remote', outcome: 'pass', reason: 'The description says remote', quote: remoteJd }
  if (locs.length) return { rule: 'remote', outcome: 'flag', reason: `No sign it's remote: listed as ${locs.join(' · ')}`, quote: locs.join(' · ') }
  return { rule: 'remote', outcome: 'unknown', reason: 'No location or remote policy found', quote: null }
}

// ---- pay -------------------------------------------------------------------------------------------

const CUR = String.raw`(?:US\$|USD\s*\$?|CA\$|C\$|CAD\s*\$?|A\$|AU\$|AUD\s*\$?|£|€|GBP\s*|EUR\s*|\$)`
const NUM = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k\b|m\b|mm\b|million\b)?`
const RANGE = new RegExp(String.raw`(${CUR})?\s*${NUM}\s*(?:USD|CAD|AUD|GBP|EUR)?\s*(?:-|–|—|to)\s*(${CUR})?\s*${NUM}(\s*(?:USD|CAD|AUD|GBP|EUR))?`, 'gi')
const SINGLE = new RegExp(String.raw`(${CUR})\s*${NUM}`, 'gi')
const HOURLY = /^\s*(?:USD\s*)?(?:\/\s*(?:hr|hour)\b|per hour|an hour|hourly)/i
const PAY_WORDS = /\b(?:salary|salaries|compensation|comp\b|pay\b|base\b|OTE\b|on[- ]target|range|annual|annually|per year|yearly|total|\bTC\b|earn|USD)\b/i
const TOTAL = /\bOTE\b|on[- ]target|total (?:target )?(?:cash|comp\w*|rewards|pay)|\bTC\b|includ\w* (?:\d+% )?(?:a |the )?(?:target )?bonus/i
const EXTRAS = /\bequity\b|\bstock\b|\bRSUs?\b|\bbonus\w*\b|\bcommission\b|\bincentive\b|\btokens?\b|\bshares\b/i
const STARTING = /\b(?:starting|starts|from|minimum|min\.?|at least)\s*(?:at\s*)?$/i

const currencyOf = (sym: string | undefined, code: string | undefined) => {
  const s = `${sym ?? ''}${code ?? ''}`.toUpperCase()
  if (/CA\$|C\$|CAD/.test(s)) return 'CAD'
  if (/A\$|AU\$|AUD/.test(s)) return 'AUD'
  if (/£|GBP/.test(s)) return 'GBP'
  if (/€|EUR/.test(s)) return 'EUR'
  return 'USD'
}

const amount = (n: string, unit: string | undefined, otherUnit?: string) => {
  let v = Number(n.replace(/,/g, ''))
  const u = (unit ?? otherUnit ?? '').toLowerCase()
  if (u === 'k') v *= 1000
  else if (u === 'm' || u === 'mm' || u === 'million') v *= 1_000_000
  return v
}

type Pay = { min: number | null; max: number | null; currency: string; text: string }

/** Every yearly pay figure in a piece of text: ranges, and single amounts ("$178,500 base"). */
const payIn = (text: string): Pay[] => {
  const out: Pay[] = []
  const taken: [number, number][] = []
  for (const m of text.matchAll(RANGE)) {
    const [whole, sym1, n1, u1, sym2, n2, u2, code] = m
    if (!sym1 && !sym2 && !code && !/\b(?:USD|CAD)\s*$/i.test(text.slice(0, m.index))) continue
    let lo = amount(n1!, u1, u2)
    let hi = amount(n2!, u2)
    if (HOURLY.test(text.slice(m.index + whole.length))) ((lo *= 2080), (hi *= 2080))
    if (hi < 20_000 || hi > 10_000_000 || lo > hi) continue
    taken.push([m.index, m.index + whole.length])
    out.push({ min: lo > 0 ? lo : null, max: hi, currency: currencyOf(sym1 ?? sym2, code), text })
  }
  for (const m of text.matchAll(SINGLE)) {
    if (taken.some(([a, b]) => m.index >= a && m.index < b)) continue
    const [whole, sym, n, u] = m
    if (/^m|mm|million$/i.test(u ?? '')) continue
    let v = amount(n!, u)
    if (HOURLY.test(text.slice(m.index + whole.length))) v *= 2080
    if (v < 20_000 || v > 10_000_000) continue
    const starting = STARTING.test(text.slice(Math.max(0, m.index - 20), m.index))
    out.push({ min: v, max: starting ? null : v, currency: currencyOf(sym, undefined), text })
  }
  return out
}

/** Pay the posting states: its comp fields first, then pay sentences in the description. */
const readPay = (input: RuleInput, texts: string[]) => {
  const fields = input.compTexts.filter((t): t is string => !!t?.trim())
  let found = fields.flatMap(payIn)
  let source = fields.join(' · ')
  if (!found.length && (input.compMax || input.compMin)) {
    const max = input.compMax || input.compMin || null
    found = [{ min: input.compMin || null, max, currency: 'USD', text: '' }]
  }
  if (!found.length) {
    for (const t of texts)
      for (const s of sentences(t)) {
        if (!PAY_WORDS.test(s)) continue
        const p = payIn(s)
        if (p.length) ((found = found.concat(p)), (source ||= quoteOf(s, RANGE)))
      }
  }
  if (!found.length) return null
  // Several ranges (by location or level): the most generous one, so only roles clearly under the floor fail.
  const currency = found[0]!.currency
  const same = found.filter((p) => p.currency === currency)
  const maxes = same.map((p) => p.max).filter((n): n is number => n !== null)
  const mins = same.map((p) => p.min).filter((n): n is number => n !== null)
  const words = [...fields, ...found.map((p) => p.text)].join(' ')
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxes.length ? Math.max(...maxes) : null,
    currency,
    basis: TOTAL.test(words) ? ('total' as const) : ('base' as const),
    extras: EXTRAS.test(words) || texts.some((t) => /\b(?:equity|RSUs?|stock options?|annual bonus|bonus target|target bonus)\b/i.test(t)),
    quote: source || null,
  }
}

const bandOf = (top: number, r: Rules): PayBand =>
  r.compFloor !== null && top < r.compFloor
    ? 'below-floor'
    : r.targetMin !== null && top < r.targetMin
      ? 'under-target'
      : r.targetMax !== null && top > r.targetMax
        ? 'above-target'
        : 'target'

const checkPay = (pay: ReturnType<typeof readPay>, r: Rules): RuleFinding | null => {
  if (r.compFloor === null && r.targetMin === null && r.targetMax === null) return null
  if (!pay) return { rule: 'pay', outcome: 'unknown', reason: 'No pay range in the posting', quote: null }
  if (pay.currency !== r.currency) return { rule: 'pay', outcome: 'unknown', reason: `Pay is in ${pay.currency}, not compared with your ${r.currency} figures`, quote: pay.quote }
  const m = (n: number) => money(n, r.currency)
  const target = r.targetMin !== null ? ` (target ${m(r.targetMin)}${r.targetMax !== null ? `–${m(r.targetMax)}` : '+'})` : ''
  if (pay.max === null) {
    const from = pay.min ?? 0
    if (r.compFloor !== null && from < r.compFloor) return { rule: 'pay', outcome: 'flag', reason: `Starts at ${m(from)} with no top posted; your floor is ${m(r.compFloor)}`, quote: pay.quote }
    return { rule: 'pay', outcome: 'pass', reason: `Starts at ${m(from)}${target}`, quote: pay.quote }
  }
  const top = pay.max
  const what = pay.basis === 'total' ? 'Total comp' : 'Base'
  if (r.compFloor !== null && top < r.compFloor) {
    const reach = top * (1 + r.equityAllowancePct / 100)
    if (pay.basis === 'base' && pay.extras && reach >= r.compFloor)
      return { rule: 'pay', outcome: 'flag', reason: `Base tops out at ${m(top)}, under your ${m(r.compFloor)} floor; equity or bonus may make up the difference`, quote: pay.quote }
    const why = pay.basis === 'total' ? '' : pay.extras ? '; too far under for equity or bonus to close' : '; no equity or bonus mentioned'
    return { rule: 'pay', outcome: 'fail', reason: `${what} tops out at ${m(top)}, under your ${m(r.compFloor)} floor${why}`, quote: pay.quote }
  }
  if (r.compFloor !== null && top === r.compFloor) return { rule: 'pay', outcome: 'flag', reason: `${what} tops out at your ${m(r.compFloor)} floor`, quote: pay.quote }
  const band = bandOf(top, r)
  const where = band === 'under-target' ? `, under your target${target}` : band === 'above-target' ? ', above your target' : r.targetMin !== null ? ', in your target band' : ''
  return { rule: 'pay', outcome: 'pass', reason: `${what} up to ${m(top)}${where}`, quote: pay.quote }
}

// ---- citizenship and clearance -----------------------------------------------------------------------

const CITIZEN = /\b(?:U\.?\s?S\.?|United States|American)\s+citizen(?:s|ship)?\b|\b(?:lawful\s+)?permanent\s+residen(?:t|ts|cy)\b|\bgreen[- ]card\b|\bU\.?\s?S\.?\s+persons?\b|\bITAR\b|\bexport[- ]control(?:s|led)?\b|\bExport Administration Regulations\b|\bdeemed exports?\b/i
const CLEARANCE = /\b(?:security|secret|top[- ]secret|TS\/SCI|TS|SCI|DoD|government|federal|active|current|interim)\s+clearances?\b|\bclearances?\s+(?:is\s+|are\s+)?(?:required|preferred|needed)\b|\b(?:obtain|maintain|hold|eligib\w*\s+(?:for|to obtain))\s+(?:an?\s+)?(?:[\w-]+\s+){0,2}clearance\b|\bpublic trust\b/i
/** Equal-opportunity boilerplate lists citizenship among things they don't discriminate on. */
const EEO = /\b(?:regardless of|without regard to|discriminat\w*|equal (?:employment )?opportunit\w*|protected (?:veteran|class|status|characteristic)|national origin)\b/i

const checkAsk = (rule: 'citizenship' | 'clearance', setting: AskRule, texts: string[]): RuleFinding | null => {
  if (setting === 'ignore') return null
  const quote =
    rule === 'citizenship'
      ? find(texts, CITIZEN, (s) => EEO.test(s) || (/sponsor/i.test(s) && !/citizen|U\.?\s?S\.? person|ITAR|export/i.test(s)))
      : find(texts, CLEARANCE, (s) => EEO.test(s))
  if (!quote) return { rule, outcome: 'pass', reason: rule === 'citizenship' ? 'No citizenship or export-control requirement found' : 'No security clearance asked for', quote: null }
  const reason = rule === 'citizenship' ? 'Asks for U.S. citizenship, permanent residency or U.S.-person (export-control) status' : 'Asks for a security clearance'
  return { rule, outcome: setting, reason, quote }
}

// ---- the check -----------------------------------------------------------------------------------

export const checkRules = (input: RuleInput, rules: Rules, at = new Date().toISOString()): RuleCheck => {
  const texts = [input.jd ?? ''].filter((t) => t.trim())
  const pay = readPay(input, texts)
  const findings = [
    rules.remoteOnly ? checkRemote(input, texts) : null,
    checkPay(pay, rules),
    checkAsk('citizenship', rules.citizenship, [...texts, ...input.locations.filter((l): l is string => !!l), ...(input.questions ?? [])]),
    checkAsk('clearance', rules.clearance, [...texts, ...(input.questions ?? [])]),
  ].filter((f): f is RuleFinding => !!f)
  const worst = findings.reduce((w, f) => Math.max(w, RANK[f.outcome]), 0)
  const result: RuleResult = worst === 2 ? 'fail' : worst === 1 ? 'flag' : 'pass'
  const top = pay && pay.currency === rules.currency ? (pay.max ?? pay.min) : null
  return {
    at,
    result,
    findings,
    pay: pay ? { min: pay.min, max: pay.max, basis: pay.basis, currency: pay.currency, extras: pay.extras } : null,
    band: top !== null && (rules.compFloor !== null || rules.targetMin !== null) ? bandOf(top, rules) : null,
  }
}

/** One line for a list: "fail: Listed as hybrid…; Base tops out at $190K…". */
export const rulesSummary = (c: Pick<RuleCheck, 'result' | 'findings'>) =>
  `${c.result}${c.result === 'pass' ? '' : `: ${c.findings.filter((f) => f.outcome === c.result).map((f) => f.reason).join('; ')}`}`
