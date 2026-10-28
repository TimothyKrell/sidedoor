import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { Effect } from 'effect'
import { z } from 'zod'
import { logActivity } from '../activity'
import { domainOf, ensureCompany } from '../companies'
import { db, schema } from '../db/client'
import { newId, nowIso } from '../ids'
import { notifyPromise } from '../notify'
import { detectAts, fetchJson, fetchText, parseRss, probeBoard } from '../scout/adapters'
import { resolveAggregatorPostings } from '../scout/resolve'
import { getApplication, setStage, trackPosting, updateApplication } from '../services/applications'
import { enqueueTask } from '../services/tasks'
import { getMeta, getSettings, setMeta } from '../settings'
import { htmlToText, truncate } from '../text'
import { mcpFor, runJob } from '../ai'
import { context, render, userName } from '../prompts'
import { runFillForm } from './fill-form'
import { buildResumePdf, tailoredFor } from '../services/resumes'
import { editDrafts, editPackage } from '../writing/editor'

// ------------------------------------------------------------------------------------------------
// Triage: score new postings in batches. Runs inline in the worker loop, not as task rows.
// ------------------------------------------------------------------------------------------------

const TriageResult = z.object({
  key: z.string(),
  decision: z.enum(['queue', 'maybe', 'skip']),
  fit_score: z.number(),
  lane: z.string().nullish(),
  summary: z.string(),
  reasons: z.array(z.string()).default([]),
  gaps: z.array(z.string()).default([]),
  location: z.enum(['ok', 'unclear', 'no']).nullish(),
  location_note: z.string().nullish(),
  compensation: z.string().nullish(),
  compensation_min: z.number().nullish(),
  compensation_max: z.number().nullish(),
  company: z.string().nullish(),
  company_domain: z.string().nullish(),
})
const TriageOut = z.object({ results: z.array(TriageResult) })

const existingAtCompany = (companyId: string | null, companyName: string | null) => {
  if (!companyId && !companyName) return '- none'
  const rows = db
    .select()
    .from(schema.applications)
    .where(companyId ? eq(schema.applications.companyId, companyId) : eq(schema.applications.companyName, companyName ?? ''))
    .all()
  return rows.map((a) => `- ${a.companyName} – ${a.role} (stage ${a.stage}, status ${a.status})`).join('\n') || '- none'
}

export const hoursSince = (iso: string | null | undefined) => (iso ? (Date.now() - new Date(iso).getTime()) / 3600_000 : null)

const maybeNotifyHot = async (postingId: string) => {
  const s = getSettings().notify
  const p = db.select().from(schema.postings).where(eq(schema.postings.id, postingId)).get()
  if (!p || p.notifiedAt || (p.fitScore ?? 0) < s.hotFitScore) return
  const age = hoursSince(p.postedAt) ?? hoursSince(p.firstSeenAt) ?? 0
  if (age > s.hotMaxAgeHours) return
  const ageLabel = age < 1 ? `${Math.max(1, Math.round(age * 60))} min ago` : `${Math.round(age)}h ago`
  db.update(schema.postings).set({ notifiedAt: nowIso() }).where(eq(schema.postings.id, p.id)).run()
  await notifyPromise({
    kind: 'hot-job',
    title: `🔥 ${p.companyName ?? 'New'} – ${p.title}`,
    body: `Fit ${p.fitScore} · posted ${ageLabel}${p.compText ? ` · ${p.compText}` : ''}\n${p.summary ?? ''}`,
    path: `/jobs/${p.id}`,
    priority: (p.fitScore ?? 0) >= 88 ? 5 : 4,
    tags: ['fire'],
    actions: [
      { label: 'Open', path: `/jobs/${p.id}` },
      ...(p.applyUrl ?? p.url ? [{ label: 'Job page', path: (p.applyUrl ?? p.url)! }] : []),
    ],
    dedupeKey: `hot:${p.id}`,
  })
}

export const runTriage = async () => {
  const s = getSettings()
  // Swap aggregator listings for the company's own posting first, so triage reads the full JD.
  const resolved = await resolveAggregatorPostings().catch((e) => (console.error('[resolve] failed', e), null))
  if (resolved && resolved.resolved + resolved.duplicate > 0) console.log(`[resolve] ${JSON.stringify(resolved)}`)
  if (!s.triage.enabled) return { triaged: 0 }
  const pending = db
    .select()
    .from(schema.postings)
    .where(and(eq(schema.postings.triageStatus, 'pending'), isNull(schema.postings.closedAt)))
    .orderBy(desc(schema.postings.firstSeenAt))
    .limit(s.triage.maxPerRun)
    .all()
  if (pending.length === 0) return { triaged: 0 }
  const criteria = context.criteria()
  const inventory = context.inventory()
  const batches: schema.Posting[][] = []
  for (let i = 0; i < pending.length; i += s.triage.batchSize) batches.push(pending.slice(i, i + s.triage.batchSize))
  const counts = { queue: 0, maybe: 0, skip: 0, error: 0 }

  const doBatch = async (batch: schema.Posting[]) => {
    const postings = batch
      .map(
        (r) => `### POSTING key=${r.key}
Company: ${r.companyName ?? '(unknown; infer from description)'}
Title: ${r.title}
Location: ${r.location ?? 'n/a'}
Posted: ${r.postedAt ?? 'unknown'}
Compensation (from ATS): ${r.compText ?? 'n/a'}
URL: ${r.url ?? ''}
Existing tracker applications at this company:
${existingAtCompany(r.companyId, r.companyName)}
Description:
${truncate(r.jd, 7000) || '(none captured)'}
`,
      )
      .join('\n')
    const prompt = render('triage', { CRITERIA: criteria, INVENTORY: inventory, POSTINGS: postings, MIN_FIT: s.triage.minFitScore })
    try {
      const r = await runJob({ job: 'triage', prompt, schema: TriageOut, maxTurns: 3, timeoutMs: 10 * 60_000 })
      return { batch, results: r.data.results }
    } catch (e) {
      console.error('[triage] batch failed', e)
      counts.error++
      return { batch, results: [] }
    }
  }

  const outcomes = await Effect.runPromise(Effect.forEach(batches, (b) => Effect.promise(() => doBatch(b)), { concurrency: 2 }))
  const queued: string[] = []
  for (const { batch, results } of outcomes) {
    const byKey = new Map(results.map((r) => [r.key, r]))
    for (const p of batch) {
      const t = byKey.get(p.key)
      if (!t) {
        db.update(schema.postings).set({ triageStatus: results.length ? 'error' : 'pending' }).where(eq(schema.postings.id, p.id)).run()
        continue
      }
      let decision = t.decision
      const score = Math.round(t.fit_score)
      if (decision === 'queue' && score < s.triage.minFitScore) decision = score >= s.triage.maybeFitScore ? 'maybe' : 'skip'
      // A strong fit skipped for a conflict (existing app, employer limits) deserves a human call.
      else if (decision === 'skip' && score >= s.triage.minFitScore) decision = 'maybe'
      // Location isn't a fit question: a great role somewhere they can't work is still one they can't take.
      const locationFit = t.location ?? null
      if (locationFit === 'no') decision = 'skip'
      else if (locationFit === 'unclear' && decision === 'queue') decision = 'maybe'
      let companyId = p.companyId
      let companyName = p.companyName
      if (t.company) {
        const c = ensureCompany(t.company, { domain: t.company_domain ?? domainOf(p.url) })
        companyId = c.id
        companyName = c.name
      }
      db.update(schema.postings)
        .set({
          triageStatus: 'done',
          decision,
          fitScore: score,
          lane: t.lane ?? null,
          summary: t.summary,
          reasons: t.reasons,
          gaps: t.gaps,
          locationFit,
          locationNote: locationFit === 'ok' ? null : (t.location_note ?? null),
          triagedAt: nowIso(),
          companyId,
          companyName,
          compText: p.compText ?? t.compensation ?? null,
          compMin: p.compMin ?? t.compensation_min ?? null,
          compMax: p.compMax ?? t.compensation_max ?? null,
        })
        .where(eq(schema.postings.id, p.id))
        .run()
      counts[decision]++
      if (decision === 'queue' && !p.applicationId) {
        trackPosting(p.id)
        queued.push(`${companyName} – ${p.title}`)
      }
      if (decision !== 'skip') await maybeNotifyHot(p.id)
    }
  }
  const triaged = counts.queue + counts.maybe + counts.skip
  if (triaged)
    logActivity('triage', `Scored ${triaged} new posting${triaged === 1 ? '' : 's'}: ${counts.queue ? `${counts.queue} strong fit${counts.queue === 1 ? '' : 's'}` : 'no strong fits'}${counts.maybe ? `, ${counts.maybe} maybe` : ''}`, {
      ...(queued.length ? { detail: queued.join(' · ') } : {}),
      link: '/jobs',
    })
  return { triaged, ...counts }
}

// ------------------------------------------------------------------------------------------------
// Task runners
// ------------------------------------------------------------------------------------------------

export interface TaskOutcome {
  output: string
  sessionId?: string | null
  costUsd?: number
  log?: string[]
  /** Re-queue for later instead of finishing. */
  deferUntil?: string
  provider?: string
  model?: string
}

/** The posting as text for prompts: header plus the description we captured. */
const jdText = (a: schema.Application, p: schema.Posting | undefined) =>
  `# ${a.companyName} – ${a.role}\n\nSource: ${a.jobUrl ?? ''}\nLocation: ${a.location ?? ''}\nCompensation: ${a.compText ?? ''}\n\n${truncate(p?.jd, 14_000) || '(no description captured; read the posting URL with read_page)'}`

const greenhouseQuestions = async (key: string | undefined) => {
  if (!key?.startsWith('greenhouse:')) return null
  const [, board, jid] = key.split(':')
  const r = await Effect.runPromise(fetchJson(`https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jid}?questions=true`).pipe(Effect.option))
  if (r._tag === 'None') return null
  const d = r.value as { questions?: Array<{ label?: string; required?: boolean; fields?: Array<{ type?: string; values?: Array<{ label?: string }> }> }>; compliance?: Array<{ label?: string }> }
  return [
    ...(d.questions ?? []).map((q) => ({
      label: q.label,
      required: q.required,
      type: (q.fields ?? []).map((f) => f.type).join(','),
      options: (q.fields ?? []).flatMap((f) => (f.values ?? []).map((v) => v.label)).slice(0, 30),
    })),
    ...(d.compliance ?? []).map((c) => ({ label: `[EEO] ${c.label}`, required: false })),
  ]
}

const PrepOut = z.object({
  summary: z.string(),
  recommendation: z.string().nullish(),
  needs_input_count: z.number().nullish(),
  cover_letter_written: z.boolean().nullish(),
})

const runPrep = async (task: schema.Task): Promise<TaskOutcome> => {
  const s = getSettings()
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  if (!a) throw new Error('application missing')
  const revision = task.input.revision === true || !!a.reviewNotes
  const inReview = db.select({ n: sql<number>`count(*)` }).from(schema.applications).where(eq(schema.applications.stage, 'review')).get()?.n ?? 0
  if (!revision && task.priority < 10 && inReview >= s.prep.maxAwaitingReview) {
    return { output: `Deferred: ${inReview} packages already awaiting review.`, deferUntil: new Date(Date.now() + 3600_000).toISOString() }
  }
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  // The tailored copy starts as the main resume; the review shows the tailoring as changes.
  const resume = tailoredFor(a.id)
  const qs = await greenhouseQuestions(p?.key)
  const locationDoubt = p?.locationFit === 'no' || p?.locationFit === 'unclear' ? `\nLocation ${p.locationFit === 'no' ? 'NOT eligible' : 'unclear'}: ${p.locationNote ?? p.location ?? ''}` : ''
  const triage = p?.summary ? `${p.summary}\nReasons: ${(p.reasons ?? []).join('; ')}\nGaps: ${(p.gaps ?? []).join('; ')}${locationDoubt}` : '(none)'
  const prompt = render('prep', {
    APP_ID: a.id,
    LEAD_NAME: `${a.companyName} – ${a.role}`,
    FIT: a.fitScore ?? 'n/a',
    TRIAGE: triage,
    RESUME_ID: resume.id,
    MAX_PAGES: s.prep.maxPages,
    JD: jdText(a, p),
    JOB_URL: a.jobUrl,
    APPLY_URL: a.applyUrl ?? a.jobUrl,
    SALARY: s.search.salaryMin ? `${s.search.salaryMin.toLocaleString('en-US')} ${s.search.currency}` : 'not set',
    FORM_QUESTIONS: qs ? JSON.stringify(qs, null, 1) : '(not pre-fetched; inspect the application page with read_page if possible, otherwise use the standard question set)',
    REVIEW_NOTES: [a.reviewNotes, typeof task.input.instructions === 'string' ? task.input.instructions : null].filter(Boolean).join('\n') || '(none: first preparation)',
  })
  const before = a.packageMd
  const r = await runJob({ job: 'prep', prompt, web: true, mcp: mcpFor('app'), schema: PrepOut, maxTurns: 80, timeoutMs: 45 * 60_000 })
  // Always rebuild the PDF from the final content so they never drift.
  const pdf = await buildResumePdf(resume.id)
  const after = getApplication(a.id)!
  const problems: string[] = []
  if (!after.packageMd || (after.packageMd === before && !revision)) problems.push('the AI did not save the application package (save_package)')
  if (pdf.pages > s.prep.maxPages) problems.push(`resume is ${pdf.pages} pages (max ${s.prep.maxPages})`)
  if (problems.length) throw new Error(problems.join('; '))
  updateApplication(a.id, { packageOriginalMd: null, editorJson: null, reviewNotes: null })
  // Separate editor pass over the cover letter and free-text answers. Never fails the prep.
  if (s.editor.enabled) {
    const ed = await editPackage(a.id).catch((e: unknown) => ({ edited: 0, error: e instanceof Error ? e.message : String(e) }))
    r.log.push(`editor pass: ${'error' in ed && ed.error ? `failed (${ed.error})` : `${ed.edited} section(s) edited`}`)
  }
  setStage(a.id, 'review', { note: r.data.summary })
  // Requirements vs. the tailored resume, for the review. Its own task so the notification doesn't wait.
  enqueueTask('match', `Check resume match: ${a.companyName} – ${a.role}`, { applicationId: a.id, priority: 5 })
  await notifyPromise({
    kind: 'package-ready',
    title: `Ready to review: ${a.companyName}`,
    body: `${a.role}\n${r.data.recommendation ?? r.data.summary}${r.data.needs_input_count ? `\n${r.data.needs_input_count} items need your decision` : ''}`,
    path: `/applications/${a.id}`,
    priority: 3,
    dedupeKey: `pkg:${a.id}:${task.id}`,
  })
  return { output: r.data.summary, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const runResearch = async (task: schema.Task): Promise<TaskOutcome> => {
  const s = getSettings()
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  if (!a) throw new Error('application missing')
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const company = a.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, a.companyId)).get() : undefined
  const known = a.companyId ? db.select().from(schema.people).where(eq(schema.people.companyId, a.companyId)).all() : []
  const prompt = render('research', {
    APP_ID: a.id,
    COMPANY: a.companyName,
    ROLE: a.role,
    FIT: a.fitScore ?? 'n/a',
    JOB_URL: a.jobUrl,
    JD: jdText(a, p),
    DOMAIN: company?.domain ?? 'unknown',
    KNOWN_PEOPLE: known.map((x) => `- ${x.name} (${x.title ?? x.kind}) id=${x.id}`).join('\n') || '- none',
    INSTRUCTIONS: typeof task.input.instructions === 'string' ? task.input.instructions : '(none)',
  })
  const r = await runJob({ job: 'research', prompt, web: true, mcp: mcpFor('app'), maxTurns: 70, timeoutMs: 40 * 60_000 })
  const linked = db.select({ n: sql<number>`count(*)` }).from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, a.id)).get()?.n ?? 0
  logActivity('research', `Researched ${a.companyName}: ${linked} people to reach`, { detail: truncate(r.text, 400), link: `/applications/${a.id}` })
  if (linked > 0) enqueueTask('outreach', `Draft outreach: ${a.companyName} – ${a.role}`, { applicationId: a.id })
  await notifyPromise({
    kind: 'research-ready',
    title: `${a.companyName}: research + ${linked} contacts`,
    body: truncate(r.text, 400),
    path: `/applications/${a.id}`,
    priority: 3,
    dedupeKey: `research:${task.id}`,
  })
  return { output: r.text, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const runOutreach = async (task: schema.Task): Promise<TaskOutcome> => {
  const s = getSettings()
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  let peopleRows: Array<schema.Person & { role?: string | null }> = []
  if (task.personId) {
    const one = db.select().from(schema.people).where(eq(schema.people.id, task.personId)).get()
    if (one) peopleRows = [one]
  } else if (a) {
    const links = db.select().from(schema.applicationPeople).where(eq(schema.applicationPeople.applicationId, a.id)).all()
    if (links.length)
      peopleRows = db.select().from(schema.people).where(inArray(schema.people.id, links.map((l) => l.personId))).all().map((p) => ({ ...p, role: links.find((l) => l.personId === p.id)?.role ?? null }))
  }
  if (peopleRows.length === 0) return { output: 'No people to write to yet.' }
  const research = a ? db.select().from(schema.research).where(eq(schema.research.applicationId, a.id)).orderBy(desc(schema.research.createdAt)).get() : undefined
  const ctx = [
    a
      ? `Application ${a.id}: ${a.companyName} – ${a.role} (stage ${a.stage}). Posting: ${a.jobUrl ?? ''}\n${a.appliedAt ? `${userName()} APPLIED on ${a.appliedAt.slice(0, 10)}.` : `${userName()} has NOT applied yet. Do not say or imply that they applied; frame it as reaching out before/while applying.`}`
      : 'No specific application (general networking / follow-up).',
    research ? `Research brief:\n${truncate(research.bodyMd, 5000)}` : '',
    'People:',
    ...peopleRows.map((p) => {
      const hist = db.select().from(schema.interactions).where(eq(schema.interactions.personId, p.id)).orderBy(desc(schema.interactions.at)).limit(6).all()
      return `- personId=${p.id} ${p.name}, ${p.title ?? ''} at ${p.companyName ?? ''} (${p.role ?? p.kind}); email ${p.email ?? 'unknown'} (${p.emailConfidence ?? 'n/a'}); linkedin ${p.linkedin ?? 'n/a'}; x ${p.x ?? 'n/a'}; stage ${p.stage}
  Why: ${truncate(p.whyMd, 800) || 'n/a'}
  History: ${hist.map((h) => `${h.at.slice(0, 10)} ${h.direction} ${h.channel}: ${h.summary}`).join(' | ') || 'none'}`
    }),
  ]
    .filter(Boolean)
    .join('\n\n')
  const prompt = render('outreach', { CONTEXT: ctx, VOICE_SAMPLE: context.voiceSample(), INSTRUCTIONS: typeof task.input.instructions === 'string' ? task.input.instructions : '(none)' })
  const startedAt = nowIso()
  const r = await runJob({ job: 'outreach', prompt, web: true, mcp: mcpFor('app'), maxTurns: 30, timeoutMs: 20 * 60_000 })
  if (s.editor.enabled) {
    // Separate editor pass over the drafts this run created.
    const created = db
      .select({ id: schema.drafts.id })
      .from(schema.drafts)
      .where(and(eq(schema.drafts.author, 'agent'), eq(schema.drafts.status, 'draft'), sql`${schema.drafts.createdAt} >= ${startedAt}`, inArray(schema.drafts.personId, peopleRows.map((p) => p.id))))
      .all()
      .map((d) => d.id)
    const ed = await editDrafts(created)
    r.log.push(`editor pass: ${ed.error ? `failed (${ed.error})` : `${ed.edited} of ${created.length} draft(s) edited`}`)
  }
  const title = a ? `Drafts ready: ${a.companyName}` : `Drafts ready: ${peopleRows[0]!.name}`
  logActivity('outreach', title, { detail: truncate(r.text, 300), link: a ? `/applications/${a.id}` : `/people/${peopleRows[0]!.id}` })
  await notifyPromise({ kind: 'agent', title, body: truncate(r.text, 300), path: a ? `/applications/${a.id}` : `/people/${peopleRows[0]!.id}`, priority: 3, dedupeKey: `outreach:${task.id}` })
  return { output: r.text, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const addSource = (v: { name: string; kind: string; board: string; url: string | null; companyId: string | null; lanes?: string[]; why?: string; origin: string; status?: 'active' | 'candidate' }) =>
  db.insert(schema.sources)
    .values({ id: newId('src_'), name: v.name, kind: v.kind, board: v.board, url: v.url, companyId: v.companyId, status: v.status ?? 'active', lanes: v.lanes ?? [], why: v.why ?? null, origin: v.origin })
    .onConflictDoNothing()
    .run().changes > 0

/** Find and register a company's ATS board from a careers URL or by probing slug guesses. */
export const attachBoard = async (company: schema.Company, careersUrl: string | null, origin: string) => {
  const existing = db.select().from(schema.sources).where(eq(schema.sources.companyId, company.id)).get()
  if (existing) return existing.kind
  let found = detectAts(careersUrl)
  if (!found && careersUrl && /^https?:/.test(careersUrl)) {
    // Careers pages usually link or embed their ATS.
    const page = await Effect.runPromise(fetchText(careersUrl).pipe(Effect.option))
    if (page._tag === 'Some') {
      const m = page.value.match(/https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[^"'\s<]+|https?:\/\/jobs\.(?:lever\.co|ashbyhq\.com)\/[^"'\s<]+|https?:\/\/apply\.workable\.com\/[^"'\s<]+/)
      found = detectAts(m?.[0])
    }
  }
  if (!found) {
    const guesses = [...new Set([company.slug.replace(/-/g, ''), company.slug, company.domain?.split('.')[0]].filter((x): x is string => !!x))]
    for (const g of guesses) {
      const r = await Effect.runPromise(probeBoard(g))
      if (r) {
        found = { kind: r.kind, board: r.board }
        break
      }
    }
  }
  if (!found) return null
  addSource({ name: company.name, kind: found.kind, board: found.board, url: careersUrl, companyId: company.id, origin })
  db.update(schema.companies).set({ atsKind: found.kind, atsBoard: found.board }).where(eq(schema.companies.id, company.id)).run()
  return found.kind
}

const FUNDING_FEEDS = [
  'https://techcrunch.com/category/fundraising/feed/',
  'https://news.crunchbase.com/feed/',
  'https://www.finsmes.com/feed',
  'https://www.theblock.co/rss.xml',
]

const FundingOut = z.object({
  companies: z.array(
    z.object({
      name: z.string(),
      domain: z.string().nullish(),
      description: z.string().nullish(),
      lanes: z.array(z.string()).default([]),
      funding_stage: z.string().nullish(),
      funding_amount: z.string().nullish(),
      funding_at: z.string().nullish(),
      funding_url: z.string().nullish(),
      careers_url: z.string().nullish(),
      relevance: z.number(),
      why: z.string(),
      outreach_angle: z.string().nullish(),
    }),
  ),
})

const runFunding = async (task: schema.Task): Promise<TaskOutcome> => {
  const s = getSettings()
  const seen = new Set(getMeta<string[]>('fundingSeen') ?? [])
  const items: Array<{ title: string; link: string; postedAt?: string | undefined; description: string }> = []
  for (const feed of FUNDING_FEEDS) {
    const r = await Effect.runPromise(fetchText(feed).pipe(Effect.option))
    if (r._tag === 'None') continue
    for (const it of parseRss(r.value)) {
      const age = hoursSince(it.postedAt) ?? 0
      if (age > 24 * 10 || seen.has(it.link)) continue
      // Most items in these feeds are funding news; keep the obviously-relevant ones.
      if (!/rais|fund|seed|series [a-e]|round|backed|\$\d/i.test(`${it.title} ${it.description}`)) continue
      items.push({ ...it, description: truncate(htmlToText(it.description), 400) })
    }
  }
  if (items.length === 0) return { output: 'No new funding news.' }
  const known = db.select({ name: schema.companies.name }).from(schema.companies).where(sql`${schema.companies.fundingAt} is not null`).all().map((c) => c.name)
  const prompt = render('funding', {
    CRITERIA: context.criteria(),
    ITEMS: items.slice(0, 120).map((i) => `- ${i.title} | ${i.link} | ${i.postedAt?.slice(0, 10) ?? ''} | ${i.description}`).join('\n'),
    KNOWN: known.join(', ') || '(none)',
  })
  const r = await runJob({ job: 'funding', prompt, web: true, mcp: mcpFor('lookup'), schema: FundingOut, maxTurns: 60, timeoutMs: 30 * 60_000 })
  setMeta('fundingSeen', [...seen, ...items.map((i) => i.link)].slice(-3000))
  const picked = r.data.companies.filter((c) => c.relevance >= 55)
  const lines: string[] = []
  for (const c of picked) {
    const co = ensureCompany(c.name, {
      domain: c.domain ?? null,
      description: c.description ?? null,
      website: c.domain ? `https://${c.domain}` : null,
    })
    db.update(schema.companies)
      .set({
        lanes: c.lanes,
        fundingStage: c.funding_stage ?? null,
        fundingAmount: c.funding_amount ?? null,
        fundingAt: c.funding_at ?? nowIso().slice(0, 10),
        fundingUrl: c.funding_url ?? null,
        fundingNote: [c.why, c.outreach_angle].filter(Boolean).join(' Outreach: '),
        interest: Math.max(co.interest, c.relevance >= 80 ? 1 : 0),
        updatedAt: nowIso(),
      })
      .where(eq(schema.companies.id, co.id))
      .run()
    const board = await attachBoard({ ...co, domain: c.domain ?? co.domain }, c.careers_url ?? null, 'funding radar')
    lines.push(`${c.name} (${c.funding_amount ?? '?'} ${c.funding_stage ?? ''}, ${c.relevance})${board ? ` → watching ${board} board` : ''}`)
  }
  if (picked.length) {
    logActivity('funding', `Funding radar: ${picked.length} newly funded companies in your lanes`, { detail: lines.join(' · '), link: '/radar' })
    const top = picked.filter((c) => c.relevance >= 75)
    if (top.length)
      await notifyPromise({
        kind: 'funding',
        title: `${top.length} just-funded ${top.length === 1 ? 'company' : 'companies'} to reach early`,
        body: top.map((c) => `${c.name}: ${c.funding_amount ?? ''} ${c.funding_stage ?? ''} — ${c.why}`).join('\n').slice(0, 900),
        path: '/radar',
        priority: 3,
        dedupeKey: `funding:${task.id}`,
      })
  }
  return { output: lines.join('\n') || 'Nothing relevant in the latest funding news.', sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const DiscoverOut = z.object({
  sources: z.array(
    z.object({
      name: z.string(),
      company: z.string().nullish(),
      kind: z.string(),
      board: z.string(),
      url: z.string().nullish(),
      lanes: z.array(z.string()).default([]),
      why: z.string().default(''),
    }),
  ),
})

const runDiscover = async (_task: schema.Task): Promise<TaskOutcome> => {
  const s = getSettings()
  const known = db.select().from(schema.sources).all().map((x) => `- ${x.name} (${x.kind}:${x.board}, ${x.status})`).join('\n')
  const tracked = [...new Set(db.select({ n: schema.applications.companyName }).from(schema.applications).all().map((r) => r.n))].join(', ')
  const prompt = render('discover', { KNOWN_SITES: known, TRACKED_COMPANIES: tracked, CRITERIA: context.criteria() })
  const r = await runJob({ job: 'discover', prompt, web: true, mcp: mcpFor('lookup'), schema: DiscoverOut, maxTurns: 60, timeoutMs: 30 * 60_000 })
  let added = 0
  for (const c of r.data.sources) {
    const det = detectAts(c.url ?? '')
    let kind = det?.kind ?? c.kind
    let board = det?.board ?? c.board
    const company = c.company ? ensureCompany(c.company, { domain: domainOf(c.url) }) : null
    if (kind === 'auto' && company) {
      const k = await attachBoard(company, c.url ?? null, 'discover')
      if (k) added++
      continue
    }
    if (!kind || !board) {
      kind = 'manual'
      board = c.url ?? c.name
    }
    if (addSource({ name: c.name, kind, board, url: c.url ?? null, companyId: company?.id ?? null, lanes: c.lanes, why: c.why, origin: 'discover', status: kind === 'manual' ? 'candidate' : 'active' })) added++
  }
  logActivity('discover', `Discovery added ${added} new job sources`, { detail: r.data.sources.map((x) => x.name).join(', '), link: '/sources' })
  return { output: `${r.data.sources.length} suggested, ${added} added`, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const runResumeNotes = async (task: schema.Task): Promise<TaskOutcome> => {
  const { baseResume, requireResume } = await import('../services/resumes')
  const id = typeof task.input.resumeId === 'string' ? task.input.resumeId : baseResume()?.id
  if (!id) throw new Error('no resume')
  const r0 = requireResume(id)
  const open = r0.notes.filter((n) => n.status === 'open')
  if (!open.length) return { output: 'No open notes.' }
  const prompt = render('resume-notes', { RESUME_ID: id, NOTES: JSON.stringify(open, null, 1) })
  const r = await runJob({ job: 'prep', prompt, mcp: mcpFor('app'), maxTurns: 60, timeoutMs: 30 * 60_000 })
  logActivity('system', 'Your AI answered your resume notes', { detail: truncate(r.text, 300), link: `/resume/${id}` })
  return { output: r.text, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

const runMatchTask = async (task: schema.Task): Promise<TaskOutcome> => {
  if (!task.applicationId) throw new Error('application missing')
  const { runMatch } = await import('../match')
  const r = await runMatch(task.applicationId)
  const missing = r.match.requirements.filter((x) => x.level === 'missing').length
  return { output: `Match ${r.match.score}/100 across ${r.match.requirements.length} requirements${missing ? `, ${missing} missing` : ''}`, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log }
}

const runCustom = async (task: schema.Task): Promise<TaskOutcome> => {
  const instructions = typeof task.input.instructions === 'string' ? task.input.instructions : task.title
  const r = await runJob({
    job: 'chat',
    prompt: `${instructions}\n\nWhen finished, reply with a short summary the user can read on their phone.`,
    system: render('system', { CRITERIA: truncate(context.criteria(), 3000) }),
    web: true,
    mcp: mcpFor('app'),
    maxTurns: 80,
    timeoutMs: 45 * 60_000,
  })
  await notifyPromise({ kind: 'agent', title: truncate(task.title, 60), body: truncate(r.text, 400), path: '/tasks', priority: 3 })
  return { output: r.text, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

export const RUNNERS: Partial<Record<schema.TaskKind, (t: schema.Task) => Promise<TaskOutcome>>> = {
  prep: runPrep,
  research: runResearch,
  outreach: runOutreach,
  funding: runFunding,
  discover: runDiscover,
  'resume-notes': runResumeNotes,
  match: runMatchTask,
  custom: runCustom,
  'submit-assist': runFillForm,
  'x-scout': (t) => import('./x-scout').then((m) => m.runXScout(t)),
  'import-resume': (t) => import('./import-resume').then((m) => m.runImportResume(t)),
}

/** Claim the next runnable task (highest priority, oldest). */
export const claimNextTask = () =>
  db.transaction((tx) => {
    const now = nowIso()
    const next = tx
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.status, 'queued'), sql`(${schema.tasks.runAfter} is null or ${schema.tasks.runAfter} <= ${now})`))
      .orderBy(desc(schema.tasks.priority), asc(schema.tasks.createdAt))
      .get()
    if (!next) return null
    tx.update(schema.tasks).set({ status: 'running', startedAt: now, attempts: next.attempts + 1 }).where(eq(schema.tasks.id, next.id)).run()
    return { ...next, status: 'running' as const, startedAt: now, attempts: next.attempts + 1 }
  })

export const executeTask = async (task: schema.Task) => {
  const runner = RUNNERS[task.kind]
  try {
    if (!runner) throw new Error(`No runner for ${task.kind}`)
    const out = await runner(task)
    if (out.deferUntil) {
      db.update(schema.tasks).set({ status: 'queued', runAfter: out.deferUntil, output: out.output, startedAt: null }).where(eq(schema.tasks.id, task.id)).run()
      return
    }
    db.update(schema.tasks)
      .set({ status: 'done', output: out.output, sessionId: out.sessionId ?? null, costUsd: out.costUsd ?? null, provider: out.provider ?? null, model: out.model ?? null, log: out.log?.join('\n\n').slice(-60_000) ?? null, finishedAt: nowIso() })
      .where(eq(schema.tasks.id, task.id))
      .run()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const log = e && typeof e === 'object' && 'log' in e && Array.isArray(e.log) ? (e.log as string[]).join('\n\n').slice(-60_000) : null
    db.update(schema.tasks).set({ status: 'failed', error: msg.slice(0, 4000), log, finishedAt: nowIso() }).where(eq(schema.tasks.id, task.id)).run()
    logActivity('system', `Task failed: ${task.title}`, { detail: msg.slice(0, 300), link: '/tasks' })
    // The application keeps its stage; say what went wrong where you'll see it.
    if (task.kind === 'prep' && task.applicationId) {
      logActivity('application', `Preparing ${getApplication(task.applicationId)?.companyName ?? 'an application'} failed`, { detail: msg.slice(0, 200), link: `/applications/${task.applicationId}` })
      updateApplication(task.applicationId, { nextAction: `Preparing failed: ${msg.slice(0, 140)}. Try again from the application.` })
    }
  }
}
