import { and, desc, eq, inArray } from 'drizzle-orm'
import { blockingFindings, checkRules, type RuleCheck, type Rules } from '@sidedoor/shared/rules'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { nowIso } from '../ids'
import { getSettings } from '../settings'
import { getApplication } from './applications'

/** The user's rules as the checker takes them; null when they turned rule checks off. */
export const currentRules = (): Rules | null => {
  const s = getSettings()
  return s.rules.enabled ? { ...s.rules, currency: s.search.currency } : null
}

/**
 * Questions the application form asks, as far as Sidedoor knows: the package's question headings
 * (prep writes one per form question) and the fields the last fill of the form reported.
 */
const formQuestions = (a: schema.Application) => {
  const fromPackage = (a.packageMd ?? '').split('\n').flatMap((l) => {
    const t = l.trim()
    const h = t.match(/^#{2,5}\s+(.+)$/)
    return h ? [h[1]!] : t.endsWith('?') ? [t] : []
  })
  const T = schema.tasks
  const last = db.select({ output: T.output }).from(T).where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, a.id), eq(T.status, 'done'))).orderBy(desc(T.createdAt)).get()
  let fromForm: string[] = []
  try {
    const o = JSON.parse(last?.output ?? 'null') as { filled?: { field: string }[]; needsYou?: { field: string }[]; submit?: { problems?: { field: string }[] } | null } | null
    fromForm = [...(o?.filled ?? []), ...(o?.needsYou ?? []), ...(o?.submit?.problems ?? [])].map((f) => f.field)
  } catch {
    fromForm = []
  }
  return [...fromPackage, ...fromForm]
}

/**
 * Check an application against the user's rules and store the result on it. Extra form questions
 * (from a fill or the board's API) are read for citizenship and clearance asks. An override given
 * earlier stays, covering the rules it was given for. Null when rule checks are off.
 */
export const checkApplicationRules = atomic((id: string, o: { questions?: string[] } = {}): RuleCheck | null => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const rules = currentRules()
  if (!rules) return null
  const P = schema.postings
  const p = a.postingId ? db.select().from(P).where(eq(P.id, a.postingId)).get() : undefined
  const check: RuleCheck = {
    ...checkRules(
      {
        locations: [p?.location, a.location],
        compTexts: [a.compText, p?.compText],
        compMin: a.compMin ?? p?.compMin,
        compMax: a.compMax ?? p?.compMax,
        jd: p?.jd,
        locationFit: p?.locationFit,
        locationNote: p?.locationNote,
        questions: [...formQuestions(a), ...(o.questions ?? [])],
      },
      rules,
      nowIso(),
    ),
    override: a.rulesJson?.override ?? null,
  }
  // A reading of the posting, not activity: lastActivityAt stays.
  db.update(schema.applications).set({ rulesJson: check, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  return check
})

/**
 * Go ahead with an application despite the rules it fails (the user's call). The override covers
 * the rules failing now; a different rule failing later blocks again.
 */
export const overrideRules = atomic((id: string, o: { by: string; note?: string | null }) => {
  const check = checkApplicationRules(id)
  if (!check) throw new Error('Rule checks are turned off (Settings → Search → Your rules); nothing to override.')
  const fails = check.findings.filter((f) => f.outcome === 'fail')
  if (!fails.length) throw new Error(`Nothing to override: it ${check.result === 'flag' ? 'is only flagged, which does not block prep or submit' : 'passes your rules'}.`)
  const next: RuleCheck = { ...check, override: { at: nowIso(), by: o.by, note: o.note?.trim() || null, rules: fails.map((f) => f.rule) } }
  db.update(schema.applications).set({ rulesJson: next, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  const a = getApplication(id)!
  logActivity('application', `Going ahead despite your rules: ${a.companyName} – ${a.role}`, { detail: [fails.map((f) => f.reason).join('; '), o.note].filter(Boolean).join('\n'), link: `/applications/${id}` })
  return next
})

/** Take back an override: the rules block this application again. */
export const clearRulesOverride = atomic((id: string) => {
  const a = getApplication(id)
  if (!a?.rulesJson?.override) return a?.rulesJson ?? null
  const next: RuleCheck = { ...a.rulesJson, override: null }
  db.update(schema.applications).set({ rulesJson: next, updatedAt: nowIso() }).where(eq(schema.applications.id, id)).run()
  return next
})

/** Stages an application still waits to go in. */
const OPEN_STAGES: schema.ApplicationStage[] = ['interested', 'review', 'approved']

export interface RuleViolation {
  applicationId: string
  company: string
  role: string
  stage: schema.ApplicationStage
  result: RuleCheck['result']
  /** True when a fail was overridden and no longer blocks. */
  overridden: boolean
  findings: RuleCheck['findings']
}

/** Re-check every application not yet sent, and list the ones that fail or are flagged, fails first. */
export const checkOpenApplications = atomic(() => {
  const A = schema.applications
  const apps = db.select({ id: A.id }).from(A).where(and(inArray(A.stage, OPEN_STAGES), inArray(A.status, ['potential', 'active', 'on-hold']))).all()
  const violations: RuleViolation[] = []
  const counts = { checked: 0, pass: 0, flag: 0, fail: 0 }
  for (const { id } of apps) {
    const c = checkApplicationRules(id)
    if (!c) return { enabled: false as const, counts, violations }
    counts.checked++
    counts[c.result]++
    if (c.result === 'pass') continue
    const a = getApplication(id)!
    violations.push({ applicationId: id, company: a.companyName, role: a.role, stage: a.stage, result: c.result, overridden: c.result === 'fail' && !blockingFindings(c).length, findings: c.findings.filter((f) => f.outcome === 'fail' || f.outcome === 'flag') })
  }
  violations.sort((x, y) => (x.result === y.result ? 0 : x.result === 'fail' ? -1 : 1))
  return { enabled: true as const, counts, violations }
})
