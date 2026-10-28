/**
 * Turn what the user said they want (roles, where they can work) into the scout's cheap regex
 * filters. Deliberately loose: the filter only keeps obvious misses away from AI triage, which
 * makes the real call. Users can edit the result under Settings → Job search → Advanced.
 */

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const STOP = new Set(['a', 'an', 'the', 'of', 'and', 'or', 'for', 'to', 'in', 'at', 'senior', 'sr', 'junior', 'jr', 'lead', 'staff', 'principal'])

/** "Senior Product Designer" → /\bproduct\b.{0,25}\bdesigner\b/: the role's core words in order, seniority left to triage. */
export const roleRegex = (role: string) => {
  const words = role
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#/ -]/gu, ' ')
    .split(/[\s/-]+/)
    .filter((w) => w && !STOP.has(w))
  if (!words.length) return null
  return words.map((w) => `\\b${esc(w)}`).join('.{0,25}')
}

const JUNIOR = '\\bintern(ship)?\\b|new grad|\\bjunior\\b|\\bjr\\.?\\b|apprentice|entry[- ]level'

export const buildTitleFilters = (roles: string[], seniority: string[]) => {
  const include = [...new Set(roles.map(roleRegex).filter((r): r is string => !!r))]
  const senior = seniority.some((s) => /senior|staff|principal|lead|manager|director|head|vp|executive/i.test(s))
  return { titleInclude: include, titleExclude: senior ? [JUNIOR] : [] }
}

/** Common ways postings name a country or region. Keys are ISO-3166 alpha-2 (plus a few regions). */
export const PLACE_ALIASES: Record<string, string[]> = {
  US: ['united states', 'usa', 'u\\.s\\.a?\\.?', '\\bus\\b', 'america', 'north america', 'americas'],
  CA: ['canada', 'toronto', 'vancouver', 'montreal', 'north america', 'americas'],
  MX: ['mexico', 'latam', 'latin america', 'americas'],
  BR: ['brazil', 'brasil', 'latam', 'latin america', 'americas'],
  AR: ['argentina', 'latam', 'latin america', 'americas'],
  GB: ['united kingdom', '\\buk\\b', 'england', 'scotland', 'london', 'emea', 'europe'],
  IE: ['ireland', 'dublin', 'emea', 'europe', '\\beu\\b'],
  DE: ['germany', 'deutschland', 'berlin', 'munich', 'emea', 'europe', '\\beu\\b', 'dach'],
  FR: ['france', 'paris', 'emea', 'europe', '\\beu\\b'],
  NL: ['netherlands', 'amsterdam', 'emea', 'europe', '\\beu\\b'],
  ES: ['spain', 'madrid', 'barcelona', 'emea', 'europe', '\\beu\\b'],
  PT: ['portugal', 'lisbon', 'emea', 'europe', '\\beu\\b'],
  PL: ['poland', 'warsaw', 'emea', 'europe', '\\beu\\b'],
  SE: ['sweden', 'stockholm', 'nordics', 'emea', 'europe', '\\beu\\b'],
  CH: ['switzerland', 'zurich', 'emea', 'europe'],
  IL: ['israel', 'tel aviv', 'emea'],
  AE: ['united arab emirates', '\\buae\\b', 'dubai', 'emea'],
  IN: ['india', 'bangalore', 'bengaluru', 'hyderabad', 'pune', 'apac', 'asia'],
  SG: ['singapore', 'apac', 'asia'],
  JP: ['japan', 'tokyo', 'apac', 'asia'],
  AU: ['australia', 'sydney', 'melbourne', 'apac', 'anz'],
  NZ: ['new zealand', 'auckland', 'apac', 'anz'],
  PH: ['philippines', 'manila', 'apac', 'asia'],
  ZA: ['south africa', 'cape town', 'johannesburg', 'emea', 'africa'],
  NG: ['nigeria', 'lagos', 'emea', 'africa'],
  KE: ['kenya', 'nairobi', 'emea', 'africa'],
}

export const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', CA: 'Canada', MX: 'Mexico', BR: 'Brazil', AR: 'Argentina', GB: 'United Kingdom', IE: 'Ireland', DE: 'Germany', FR: 'France', NL: 'Netherlands', ES: 'Spain', PT: 'Portugal', PL: 'Poland', SE: 'Sweden', CH: 'Switzerland', IL: 'Israel', AE: 'United Arab Emirates', IN: 'India', SG: 'Singapore', JP: 'Japan', AU: 'Australia', NZ: 'New Zealand', PH: 'Philippines', ZA: 'South Africa', NG: 'Nigeria', KE: 'Kenya',
}

/**
 * locationOk: places the user named, their country's aliases, and "anywhere". locationBlock: every
 * other known place, so "Remote - Europe" fails for someone in the US while "Remote" passes.
 */
export const buildLocationFilters = (country: string, locations: string[]) => {
  const c = country.toUpperCase()
  const ok = new Set<string>(['anywhere', 'worldwide', 'global'])
  for (const a of PLACE_ALIASES[c] ?? []) ok.add(a)
  for (const l of locations) {
    const key = Object.entries(COUNTRY_NAMES).find(([, n]) => n.toLowerCase() === l.trim().toLowerCase())?.[0]
    if (key) for (const a of PLACE_ALIASES[key] ?? []) ok.add(a)
    else if (l.trim()) ok.add(esc(l.trim().toLowerCase()))
  }
  if (!c && !locations.length) return { locationOk: '', locationBlock: '' }
  const okList = [...ok]
  const block = new Set<string>()
  for (const [k, aliases] of Object.entries(PLACE_ALIASES)) {
    if (k === c) continue
    for (const a of aliases) if (!okList.includes(a)) block.add(a)
  }
  return { locationOk: okList.join('|'), locationBlock: [...block].join('|') }
}
