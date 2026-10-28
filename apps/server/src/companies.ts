import { eq } from 'drizzle-orm'
import { db, schema } from './db/client'
import { newId, nowIso, slugify } from './ids'

export const companySlug = (name: string) =>
  slugify(name.replace(/,?\s+(inc|llc|ltd|labs?|corp|co|technologies|hq)\.?$/i, '')) || slugify(name)

/** Find or create a company by name. Fills in blank fields from `extra` without overwriting. */
export const ensureCompany = (
  name: string,
  extra: Partial<Omit<typeof schema.companies.$inferInsert, 'id' | 'name' | 'slug'>> = {},
) => {
  const clean = name.trim()
  const slug = companySlug(clean)
  const existing = db.select().from(schema.companies).where(eq(schema.companies.slug, slug)).get()
  if (existing) {
    const patch: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(extra)) {
      if (v != null && (existing as Record<string, unknown>)[k] == null) patch[k] = v
    }
    // Prefer a properly-cased name over a lowercase board token.
    if (existing.name === existing.name.toLowerCase() && clean !== clean.toLowerCase()) patch.name = clean
    if (Object.keys(patch).length) {
      db.update(schema.companies).set({ ...patch, updatedAt: nowIso() }).where(eq(schema.companies.id, existing.id)).run()
      return { ...existing, ...patch } as schema.Company
    }
    return existing
  }
  const row = { id: newId('co_'), name: clean, slug, ...extra }
  db.insert(schema.companies).values(row).run()
  return db.select().from(schema.companies).where(eq(schema.companies.id, row.id)).get()!
}

export const domainOf = (url: string | null | undefined) => {
  if (!url) return null
  try {
    const h = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.replace(/^www\./, '')
    return /greenhouse|lever|ashby|workable|smartrecruiters|linkedin|ycombinator|wellfound/.test(h) ? null : h
  } catch {
    return null
  }
}
