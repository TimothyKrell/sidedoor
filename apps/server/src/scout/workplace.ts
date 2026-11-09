/**
 * Where and how a posting can be worked, read from its title, location and description before any
 * AI sees it. Two questions: does it name only places the user can't work, and, for someone who
 * works remotely only, does it show it's remote? A posting that says nothing either way about
 * remote, or says hybrid or office days without saying remote, doesn't reach scoring.
 */

/** Countries and regions as postings name them. Georgia and Jersey are left out: they're also US places. */
const COUNTRIES = [
  'afghanistan', 'albania', 'algeria', 'andorra', 'angola', 'argentina', 'armenia', 'australia', 'austria', 'azerbaijan',
  'bahamas', 'bahrain', 'bangladesh', 'barbados', 'belarus', 'belgium', 'belize', 'benin', 'bhutan', 'bolivia',
  'bosnia', 'botswana', 'brazil', 'brasil', 'brunei', 'bulgaria', 'burkina faso', 'burundi', 'cambodia', 'cameroon',
  'canada', 'cape verde', 'chad', 'chile', 'china', 'colombia', 'congo', 'costa rica', "cote d'ivoire", 'croatia',
  'cuba', 'cyprus', 'czech republic', 'czechia', 'denmark', 'djibouti', 'dominican republic', 'ecuador', 'egypt', 'el salvador',
  'estonia', 'eswatini', 'ethiopia', 'fiji', 'finland', 'france', 'gabon', 'gambia', 'germany', 'deutschland',
  'ghana', 'greece', 'guatemala', 'guinea', 'guyana', 'haiti', 'honduras', 'hong kong', 'hungary', 'iceland',
  'india', 'indonesia', 'iran', 'iraq', 'ireland', 'israel', 'italy', 'jamaica', 'japan', 'jordan',
  'kazakhstan', 'kenya', 'kosovo', 'kuwait', 'kyrgyzstan', 'laos', 'latvia', 'lebanon', 'lesotho', 'liberia',
  'libya', 'liechtenstein', 'lithuania', 'luxembourg', 'macau', 'madagascar', 'malawi', 'malaysia', 'maldives', 'mali',
  'malta', 'mauritania', 'mauritius', 'mexico', 'moldova', 'monaco', 'mongolia', 'montenegro', 'morocco', 'mozambique',
  'myanmar', 'namibia', 'nepal', 'netherlands', 'new zealand', 'nicaragua', 'niger', 'nigeria', 'north macedonia', 'norway',
  'oman', 'pakistan', 'palestine', 'panama', 'papua new guinea', 'paraguay', 'peru', 'philippines', 'poland', 'portugal',
  'qatar', 'romania', 'russia', 'rwanda', 'saudi arabia', 'senegal', 'serbia', 'seychelles', 'sierra leone', 'singapore',
  'slovakia', 'slovenia', 'somalia', 'south africa', 'south korea', 'korea', 'spain', 'sri lanka', 'sudan', 'suriname',
  'sweden', 'switzerland', 'syria', 'taiwan', 'tajikistan', 'tanzania', 'thailand', 'togo', 'trinidad', 'tunisia',
  'turkey', 'türkiye', 'turkmenistan', 'uganda', 'ukraine', 'united arab emirates', 'uae', 'united kingdom', 'uk', 'england',
  'scotland', 'wales', 'northern ireland', 'uruguay', 'uzbekistan', 'venezuela', 'vietnam', 'viet nam', 'yemen', 'zambia', 'zimbabwe',
  'united states', 'usa', 'u.s.', 'us', 'america',
]
const REGIONS = ['latam', 'latin america', 'south america', 'central america', 'caribbean', 'emea', 'europe', 'eu', 'apac', 'asia', 'asia pacific', 'africa', 'middle east', 'mena', 'oceania', 'anz', 'nordics', 'dach', 'benelux', 'north america', 'americas', 'namer', 'amer']

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const wordRe = (words: string[]) => (words.length ? new RegExp(`(?<![\\p{L}.])(?:${words.map(esc).join('|')})(?![\\p{L}])`, 'iu') : null)

/** Places the user's "where I can work" pattern doesn't cover: every country and region it doesn't match. */
export const foreignPlaces = (ok: RegExp | null) => (ok ? wordRe([...COUNTRIES, ...REGIONS].filter((p) => !ok.test(p))) : null)

/** US states named alike elsewhere ("New Mexico", "New South Wales" is fine): taken out before looking for countries. */
const LOOKALIKES = /\bnew mexico\b|\bnew jersey\b|\bwest virginia\b|\bnew england\b/gi

/** A location piece that only says how, not where: "Remote", "Hybrid", "OnSite", "Distributed". */
const MODE_ONLY = /^\s*(remote|hybrid|on-?site|in[- ]office|office|distributed|flexible|remote[- ]friendly|remote[- ]first|work from home|wfh)\s*$/i

export interface PlaceFilters {
  locationOk: RegExp | null
  remote: RegExp | null
  block: RegExp | null
  foreign: RegExp | null
}

/**
 * The location names somewhere the user can work. Each listed place is read on its own ("Spain |
 * USA (Remote)" passes on its USA), a piece that only says Remote or Hybrid applies to them all,
 * and a remote place that names a country or region the user can't work in ("Remote, Latin
 * America") doesn't count as remote. No location, or no preferences, gets the benefit of the doubt.
 */
export const placePasses = (loc: string | null | undefined, f: PlaceFilters) => {
  if (!loc || (!f.locationOk && !f.block)) return true
  const pieces = loc.split(/\s*[|;]\s*|\s+\/\s+/).filter(Boolean)
  const places = pieces.filter((p) => !MODE_ONLY.test(p))
  const remoteAny = !!f.remote?.test(loc)
  if (!places.length) return true
  return places.some((p) => {
    if (f.locationOk?.test(p)) return true
    const bare = p.replace(LOOKALIKES, ' ')
    if (f.foreign?.test(bare) || f.block?.test(bare)) return false
    // A place we can't place (a city with no country): fine when the posting says remote.
    return remoteAny
  })
}

// ---- remote or not -----------------------------------------------------------------------------

const SAYS_REMOTE = /\bremote(ly)?\b|work(ing)? from (home|anywhere)|\bwfh\b|\bfully distributed\b|\bdistributed (team|company|workforce)\b|\banywhere in the (us|u\.s\.|united states|country)\b/i
const LISTED_NOT_REMOTE = /\bhybrid\b|\bon-?site\b|\bin[- ]office\b|\bin[- ]person\b/i
const NOT_REMOTE_TEXT = new RegExp(
  [
    '#li-(onsite|hybrid)',
    // "Hybrid" alone is often cloud or search; only as a way of working.
    '\\bhybrid (role|position|job|schedule|work|working|model|arrangement|policy|environment|setup)\\b',
    '\\b(is|be|are|role is|position is) hybrid\\b',
    '\\(hybrid\\)',
    '\\bhybrid[,:]? (in|from|based|at|out of) [A-Z]',
    '\\b(\\d|one|two|three|four|five)\\+? days? (a|per|each) week (in|at|from) (the |our |an? )?(office|person|hq|headquarters|studio)',
    '\\b(in|at) (the |our )?(office|hq|headquarters) (\\d|one|two|three|four|five)\\+? days',
    '\\bin[- ](office|person) (\\d|one|two|three|four|five)\\+? days',
    "\\b(office|hq|headquarters|studio)\\b[^.\\n]{0,25}\\b(\\d|one|two|three|four|five)\\+? days? (a|per|each) week",
    '\\bin[- ]office (anchor )?days\\b',
    '\\b\\d{2}% (of (the|your) time )?(in|at) (the |our )?office',
    '\\bthis (role|position|job) is (an? )?(on-?site|in[- ]office|in[- ]person)',
    '\\b(on-?site|in[- ]office|in[- ]person) (role|position|job)\\b',
    '\\bthis (role|position|job) (is|will be) (based|located) (in|at|out of) (our|the|a)\\b',
    '\\bnot (a |eligible for )?remote\\b',
    '\\bno remote\\b',
    '\\bremote (work )?(is not|isn\'t) (available|an option|offered)',
    '\\bmust (be able to )?(commute|work from our|be in (the|our) office)',
    '\\brelocat(e|ion) to\\b',
  ].join('|'),
  'i',
)

export type WorkplaceVerdict = 'remote' | 'not remote' | 'unclear'

/**
 * Remote or not, from what the posting shows. The board's own flag shows up in the location
 * ("Remote", "Hybrid", "OnSite"). A description that never says remote isn't a remote job; one
 * listed remote that also asks for office days is left for scoring to judge. With no description
 * yet (a listing still to be matched to its original), only the title and location count, and it's
 * unclear unless they say. `final`: no description is coming (the last check before scoring), so
 * a posting that doesn't say remote anywhere isn't remote.
 */
export const workplaceOf = (job: { title: string; location?: string | null; jd?: string | null }, final = false): WorkplaceVerdict => {
  const head = `${job.title} | ${job.location ?? ''}`
  const jd = job.jd ?? ''
  const listedRemote = SAYS_REMOTE.test(head)
  const listedNot = LISTED_NOT_REMOTE.test(head)
  const hasJd = jd.length >= 300
  const jdNot = hasJd && NOT_REMOTE_TEXT.test(jd)
  const jdRemote = hasJd && SAYS_REMOTE.test(jd)
  if (listedRemote) return jdNot || listedNot ? 'unclear' : 'remote'
  if (listedNot) return jdRemote && !jdNot ? 'unclear' : 'not remote'
  if (!hasJd) return final ? 'not remote' : 'unclear'
  if (jdNot) return 'not remote'
  return jdRemote ? 'remote' : 'not remote'
}
