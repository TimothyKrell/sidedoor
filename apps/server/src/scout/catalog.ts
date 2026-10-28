import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ensureCompany } from '../companies'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { newId } from '../ids'
import { getSettings } from '../settings'

/**
 * Starter job sources for onboarding (defaults/sources.json): general job feeds plus public
 * company boards tagged by industry. New users pick from these instead of starting from nothing;
 * the daily discovery job finds more in their lanes.
 */
interface CatalogEntry {
  id: string
  name: string
  kind: string
  board: string
  domain?: string | null
  tags: string[]
}
interface Catalog {
  feeds: CatalogEntry[]
  companies: CatalogEntry[]
}

let cache: Catalog | null = null
const catalog = (): Catalog => (cache ??= JSON.parse(readFileSync(resolve(paths.defaults, 'sources.json'), 'utf8')) as Catalog)

const ROLE_TAGS = new Set(['engineering', 'design', 'product', 'management', 'sales', 'marketing', 'support'])

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)

/** The catalog with suggestions marked from the user's lanes and roles. */
export const catalogForUser = () => {
  const s = getSettings().search
  const lanes = new Set(s.lanes.flatMap(words))
  // Job titles imply which feeds matter: a designer wants design boards, not every remote board.
  const roleTags = new Set<string>()
  const roleText = s.roles.join(' ').toLowerCase()
  if (/engineer|developer|frontend|backend|full.?stack|devops|sre|software|programmer|cto|architect/.test(roleText)) roleTags.add('engineering')
  if (/design|ux|ui\b/.test(roleText)) roleTags.add('design')
  if (/product (manager|owner|lead)|\bpm\b|product management/.test(roleText)) roleTags.add('product')
  if (/sales|account exec|marketing|growth|seo|content/.test(roleText)) {
    roleTags.add('sales')
    roleTags.add('marketing')
  }
  if (/support|customer success|success manager|community/.test(roleText)) roleTags.add('support')
  if (/manager|director|head of|vp|chief|lead\b/.test(roleText)) roleTags.add('management')
  const existing = new Set(db.select({ kind: schema.sources.kind, board: schema.sources.board }).from(schema.sources).all().map((r) => `${r.kind}:${r.board}`))
  const remote = s.workModes.includes('remote')
  /** Feeds are split by role: suggest the ones for your roles, plus general remote boards if you work remotely. */
  const feedScore = (e: CatalogEntry) => {
    const tagWords = e.tags.flatMap(words)
    const roleTagged = tagWords.filter((t) => ROLE_TAGS.has(t))
    if (roleTagged.length) return roleTagged.some((t) => roleTags.has(t)) ? 2 : 0
    if (tagWords.some((t) => lanes.has(t))) return 2
    return tagWords.includes('remote') && remote ? 1 : 0
  }
  /**
   * Company boards list every role, so they are split by industry: your lanes, or a starter set
   * spread across the catalog's industries if you named none.
   */
  const starter = new Set<string>()
  if (!lanes.size && roleTags.size) {
    const byLane = new Map<string, CatalogEntry[]>()
    for (const c of catalog().companies) {
      const lane = c.tags[0] ?? 'other'
      byLane.set(lane, [...(byLane.get(lane) ?? []), c])
    }
    const queues = [...byLane.values()]
    for (let i = 0; starter.size < 15 && queues.some((q) => q.length > i); i++) for (const q of queues) if (q[i] && starter.size < 15) starter.add(q[i]!.id)
  }
  const companyScore = (e: CatalogEntry) => {
    if (lanes.size) return e.tags.flatMap(words).some((t) => lanes.has(t)) ? 2 : 0
    return starter.has(e.id) ? 1 : 0
  }
  const mark = (score: (e: CatalogEntry) => number) => (e: CatalogEntry) => ({ ...e, suggested: score(e) > 0, added: existing.has(`${e.kind}:${e.board}`) })
  const tags = [...new Set(catalog().companies.flatMap((c) => c.tags))].sort()
  return { feeds: catalog().feeds.map(mark(feedScore)), companies: catalog().companies.map(mark(companyScore)), tags }
}

export const addCatalogSources = (ids: string[]) => {
  const want = new Set(ids)
  let added = 0
  for (const e of [...catalog().feeds, ...catalog().companies]) {
    if (!want.has(e.id)) continue
    const isCompany = !['rss', 'remoteok', 'hn'].includes(e.kind)
    const company = isCompany ? ensureCompany(e.name, { domain: e.domain ?? null, atsKind: e.kind, atsBoard: e.board }) : null
    const r = db
      .insert(schema.sources)
      .values({ id: newId('src_'), name: e.name, kind: e.kind, board: e.board, url: null, companyId: company?.id ?? null, status: 'active', lanes: e.tags, origin: 'starter' })
      .onConflictDoUpdate({ target: [schema.sources.kind, schema.sources.board], set: { status: 'active' } })
      .run()
    added += r.changes
  }
  return added
}
