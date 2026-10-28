import { getSecret } from '../secrets'
import { resolveMx } from 'node:dns/promises'
import { and, eq } from 'drizzle-orm'
import { db, schema } from '../db/client'

export interface EmailCandidate {
  email: string
  confidence: 'verified' | 'published' | 'pattern' | 'guessed'
  source: string
  score?: number
}

const clean = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z\s-]/g, '')
    .trim()

/** Common corporate patterns, roughly in order of how often startups use them. */
export const PATTERNS = ['{first}', '{first}.{last}', '{first}{last}', '{f}{last}', '{first}{l}', '{first}_{last}', '{last}', '{f}.{last}'] as const

export const applyPattern = (pattern: string, fullName: string, domain: string) => {
  const parts = clean(fullName).split(/\s+/).filter(Boolean)
  const first = parts[0] ?? ''
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : ''
  if (!first || (pattern.includes('{last}') && !last) || (pattern.includes('{l}') && !last)) return null
  const local = pattern
    .replace('{first}', first)
    .replace('{last}', last.replace(/-/g, ''))
    .replace('{f}', first[0] ?? '')
    .replace('{l}', last[0] ?? '')
  return `${local}@${domain}`
}

export const hasMx = async (domain: string) => {
  try {
    return (await resolveMx(domain)).length > 0
  } catch {
    return false
  }
}

const hunter = async (path: string, params: Record<string, string>) => {
  const key = getSecret('hunter-api-key')
  if (!key) return null
  const q = new URLSearchParams({ ...params, api_key: key })
  const res = await fetch(`https://api.hunter.io/v2/${path}?${q}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return null
  return (await res.json()) as { data?: Record<string, unknown> }
}

/** Which common patterns produce `email` for this person (usually one; several for one-word names). */
export const patternsOf = (email: string, fullName: string): string[] => {
  const [local, domain] = email.toLowerCase().split('@')
  if (!local || !domain) return []
  return PATTERNS.filter((p) => applyPattern(p, fullName, domain) === `${local}@${domain}`)
}

/**
 * Pattern of a real address whose author name may be a GitHub handle ("willporter-workos"): try the
 * name, then the handle as a name, then the address's own shape (a dot or underscore between two words).
 */
const shapeOf = (email: string, author: string, org: string): string[] => {
  const byName = patternsOf(email, author)
  if (byName.length) return byName
  const handle = author.toLowerCase().replace(new RegExp(`[-_]?${org}$`), '').replace(/[-_]/g, ' ')
  const byHandle = handle.includes(' ') ? patternsOf(email, handle) : []
  if (byHandle.length) return byHandle
  const local = email.split('@')[0] ?? ''
  if (/^[a-z]+\.[a-z]+$/.test(local)) return ['{first}.{last}']
  if (/^[a-z]+_[a-z]+$/.test(local)) return ['{first}_{last}']
  return []
}

export interface EmailEvidence {
  /** Real addresses at the domain with the name they were published under. */
  addresses: Array<{ name: string; email: string; where: string }>
  /** Patterns ranked by how many of those addresses follow them. */
  patterns: Array<{ pattern: string; count: number }>
}

const gh = async (path: string) => {
  const res = await fetch(`https://api.github.com${path}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'sidedoor' }, signal: AbortSignal.timeout(15_000) })
  return res.ok ? ((await res.json()) as unknown) : null
}

const evidenceCache = new Map<string, { at: number; v: EmailEvidence }>()

/**
 * Real addresses at a domain from public GitHub commits by the company's org (default: the domain's
 * first label, e.g. workos.com → workos). Commit authors are employees using their work address,
 * which shows the actual pattern, often more than one (early employees on {first}, later hires on
 * {first}.{last}).
 */
export const emailEvidence = async (domain: string, githubOrg?: string | null): Promise<EmailEvidence> => {
  const d = domain.toLowerCase()
  const org = (githubOrg || d.split('.')[0] || '').toLowerCase()
  const key = `${d}|${org}`
  const hit = evidenceCache.get(key)
  if (hit && Date.now() - hit.at < 86_400_000) return hit.v
  const seen = new Map<string, { name: string; email: string; where: string }>()
  const repos = (await gh(`/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=8&type=public`).catch(() => null)) as Array<{ full_name: string; fork: boolean }> | null
  for (const r of (Array.isArray(repos) ? repos : []).filter((x) => !x.fork).slice(0, 6)) {
    const commits = (await gh(`/repos/${r.full_name}/commits?per_page=100`).catch(() => null)) as Array<{ commit: { author: { name: string; email: string } | null; committer: { name: string; email: string } | null } }> | null
    for (const c of Array.isArray(commits) ? commits : []) {
      for (const a of [c.commit.author, c.commit.committer]) {
        const email = a?.email?.toLowerCase()
        if (a && email?.endsWith(`@${d}`) && !/noreply|bot|ci@|deploy|github/.test(email) && !seen.has(email)) seen.set(email, { name: a.name, email, where: `github.com/${r.full_name} commits` })
      }
    }
  }
  const addresses = [...seen.values()]
  const counts = new Map<string, number>()
  for (const a of addresses) for (const p of shapeOf(a.email, a.name, org)) counts.set(p, (counts.get(p) ?? 0) + 1)
  const v = { addresses, patterns: [...counts].map(([pattern, count]) => ({ pattern, count })).sort((a, b) => b.count - a.count) }
  evidenceCache.set(key, { at: Date.now(), v })
  return v
}

const sameName = (a: string, b: string) => clean(a).split(/\s+/).join(' ') === clean(b).split(/\s+/).join(' ')

/** Hunter's verifier (SMTP check from their servers): deliverable, undeliverable, risky/accept_all, or unknown. */
const verify = async (email: string) => {
  const h = await hunter('email-verifier', { email }).catch(() => null)
  const r = h?.data && typeof h.data.result === 'string' ? h.data.result : null
  return r as 'deliverable' | 'undeliverable' | 'risky' | null
}

/**
 * Best-effort email discovery for a person at a company domain, best candidate first:
 * their own address in public commits → Hunter (if a key is configured) → the company's known
 * pattern → patterns seen in public commits (most common first) → common patterns (MX-checked).
 * Addresses that bounced for this person are skipped; formats that bounced for others here rank last.
 * With a Hunter key, the top guesses are verified. We never probe SMTP from here: it's blocked on
 * home connections and hurts sender reputation.
 */
export const findEmail = async (
  fullName: string,
  domain: string,
  o: { knownPattern?: string | null; badPatterns?: readonly string[] | null; bounced?: readonly string[] | null; githubOrg?: string | null } = {},
): Promise<{ mx: boolean; candidates: EmailCandidate[]; evidence: EmailEvidence }> => {
  const d = domain.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').toLowerCase()
  const bad = new Set(o.badPatterns ?? [])
  const bounced = new Set((o.bounced ?? []).map((e) => e.toLowerCase()))
  const [mx, evidence] = await Promise.all([hasMx(d), emailEvidence(d, o.githubOrg).catch(() => ({ addresses: [], patterns: [] }))])
  const out: EmailCandidate[] = []
  const add = (c: EmailCandidate | null) => {
    if (c && !bounced.has(c.email) && !out.some((x) => x.email === c.email)) out.push(c)
  }
  const own = evidence.addresses.find((a) => sameName(a.name, fullName))
  if (own) add({ email: own.email, confidence: 'published', source: own.where })
  const parts = clean(fullName).split(/\s+/)
  const h = await hunter('email-finder', { domain: d, first_name: parts[0] ?? '', last_name: parts[parts.length - 1] ?? '' }).catch(() => null)
  const he = h?.data && typeof h.data.email === 'string' ? h.data.email.toLowerCase() : null
  if (he) add({ email: he, confidence: 'verified', source: 'hunter.io email-finder', score: Number(h?.data?.score ?? 0) })
  // Formats that bounced for someone else here go last, not away: companies often use two formats.
  const later: EmailCandidate[] = []
  const addFmt = (p: string, c: EmailCandidate | null) => {
    if (!c) return
    if (bad.has(p)) later.push({ ...c, confidence: 'guessed', source: `${c.source}; this format bounced for someone else at ${d}` })
    else add(c)
  }
  if (o.knownPattern) {
    const e = applyPattern(o.knownPattern, fullName, d)
    addFmt(o.knownPattern, e ? { email: e, confidence: 'pattern', source: `company pattern ${o.knownPattern}` } : null)
  }
  const total = evidence.addresses.length
  for (const p of evidence.patterns) {
    const e = applyPattern(p.pattern, fullName, d)
    addFmt(p.pattern, e ? { email: e, confidence: 'guessed', source: `${p.count} of ${total} public ${d} addresses use ${p.pattern} (GitHub commits)` } : null)
  }
  if (mx) {
    for (const p of PATTERNS) {
      const e = applyPattern(p, fullName, d)
      addFmt(p, e ? { email: e, confidence: 'guessed', source: `common pattern ${p}` } : null)
    }
  }
  for (const c of later) add(c)
  // Verify the top unverified guesses when Hunter is set up (each check uses a credit).
  if (getSecret('hunter-api-key')) {
    for (const c of out.filter((x) => x.confidence === 'guessed' || x.confidence === 'pattern').slice(0, 3)) {
      const r = await verify(c.email)
      if (r === 'deliverable') Object.assign(c, { confidence: 'verified', source: `${c.source}; hunter.io verified deliverable` })
      else if (r === 'undeliverable') bounced.add(c.email)
      else if (r === 'risky') c.source += '; hunter.io: server accepts any address, unconfirmed'
    }
  }
  const rank = { verified: 0, published: 1, pattern: 2, guessed: 3 }
  // Stable sort: within a confidence level, the evidence order above holds (demoted formats stay last).
  const candidates = out.filter((c) => !bounced.has(c.email)).sort((a, b) => rank[a.confidence] - rank[b.confidence])
  return { mx, candidates, evidence: { addresses: evidence.addresses.slice(0, 15), patterns: evidence.patterns } }
}

/** Hunter's domain search tells us the company's email pattern and a few real addresses. */
export const domainPattern = async (domain: string) => {
  const h = await hunter('domain-search', { domain, limit: '10' }).catch(() => null)
  if (!h?.data) return null
  // Hunter already reports patterns in our {first}.{last} notation.
  return { pattern: typeof h.data.pattern === 'string' ? h.data.pattern : null, emails: Array.isArray(h.data.emails) ? h.data.emails : [] }
}

/** findEmail with what we know about the company and person: its pattern, bounced patterns and addresses. */
export const findEmailFor = async (v: { name: string; domain: string; companyId?: string | null; personId?: string | null; githubOrg?: string | null }) => {
  const company = v.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, v.companyId)).get() : undefined
  const person = v.personId
    ? db.select().from(schema.people).where(eq(schema.people.id, v.personId)).get()
    : v.companyId
      ? db.select().from(schema.people).where(and(eq(schema.people.name, v.name), eq(schema.people.companyId, v.companyId))).get()
      : undefined
  return findEmail(v.name, v.domain, { knownPattern: company?.emailPattern, badPatterns: company?.badEmailPatterns, bounced: person?.bouncedEmails, githubOrg: v.githubOrg })
}
