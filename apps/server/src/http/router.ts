import { desc, eq } from 'drizzle-orm'
import { Effect } from 'effect'
import { z } from 'zod'
import type { ResumeContent } from '@sidedoor/shared/resume'

/**
 * Every call the web app makes: `POST /api/rpc/<name>` with a JSON body. Input is validated with
 * zod; output types flow to the client through `import type { Router }` (apps/web/src/lib/rpc.ts).
 * Handlers stay thin: they call the same service commands the MCP tools and jobs use.
 */
const proc = <I extends z.ZodType, O>(input: I, handler: (i: z.infer<I>) => O | Promise<O>) => ({ input, handler })
const none = z.object({}).optional()
const id = z.object({ id: z.string() })

// Server modules load lazily so a cold start stays quick.
const q = () => import('../queries')
const apps = () => import('../services/applications')
const people = () => import('../services/people')
const tasks = () => import('../services/tasks')
const resumes = () => import('../services/resumes')
const docs = () => import('../services/documents')
const settingsm = () => import('../settings')
const dbm = () => import('../db/client')

const PostingFilters = z.object({
  window: z.enum(['6h', '24h', '72h', '7d', '30d', 'all']).optional(),
  minFit: z.number().optional(),
  decision: z.enum(['queue', 'maybe', 'skip', 'triaged', 'all']).optional(),
  status: z.enum(['new', 'starred', 'dismissed', 'tracked', 'all']).optional(),
  q: z.string().optional(),
})
const PeopleFilters = z.object({
  q: z.string().optional(),
  kind: z.string().optional(),
  view: z.enum(['due', 'all', 'recruiters', 'engaged', 'not-contacted']).optional(),
})
const Stage = z.enum(['interested', 'review', 'approved', 'applied', 'screening', 'interviewing', 'offer', 'closed'])
const PersonInput = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  companyName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  kind: z.enum(['recruiter', 'hiring-manager', 'founder', 'referral', 'network', 'interviewer', 'other']).optional(),
  email: z.string().nullable().optional(),
  emailConfidence: z.string().nullable().optional(),
  linkedin: z.string().nullable().optional(),
  x: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  stage: z.enum(['not-contacted', 'contacted', 'replied', 'engaged', 'dormant']).optional(),
  priority: z.enum(['high', 'medium', 'low']).optional(),
  nextContactAt: z.string().nullable().optional(),
  cadenceDays: z.number().nullable().optional(),
  nextAction: z.string().nullable().optional(),
  whyMd: z.string().nullable().optional(),
  notesMd: z.string().nullable().optional(),
  applicationId: z.string().optional(),
  role: z.string().optional(),
})
const ProviderId = z.enum(['claude', 'codex', 'grok', 'opencode'])
const DocKey = z.enum(['experience', 'search', 'answers', 'writing', 'stories', 'tells'])
const ThemeOptions = z.object({ accent: z.string().optional(), paper: z.enum(['letter', 'a4']).optional(), scale: z.number().optional(), showHighlights: z.boolean().optional() })

const scoutNow = async () => (await settingsm()).setMeta('scoutNow', new Date().toISOString())

export const router = {
  // ------------------------------------------------------------------ reads
  today: proc(none, async () => (await q()).getToday()),
  postings: proc(PostingFilters, async (f) => (await q()).listPostings(f)),
  posting: proc(id, async ({ id }) => (await q()).getPosting(id)),
  applications: proc(none, async () => (await q()).listApplications()),
  application: proc(id, async ({ id }) => (await q()).getApplicationDetail(id)),
  people: proc(PeopleFilters, async (f) => (await q()).listPeople(f as never)),
  person: proc(id, async ({ id }) => (await q()).getPersonDetail(id)),
  radar: proc(none, async () => (await q()).listRadar()),
  tasks: proc(none, async () => (await q()).listTasks()),
  sources: proc(none, async () => (await q()).listSources()),
  threads: proc(none, async () => (await q()).listThreads()),
  panelThreads: proc(z.object({ page: z.string().nullable() }), async ({ page }) => (await q()).panelThreads(page)),
  thread: proc(id, async ({ id }) => (await q()).getThread(id)),
  status: proc(none, async () => (await q()).workerStatus()),
  search: proc(z.object({ q: z.string() }), async ({ q: s }) => (await q()).searchAll(s)),
  tellRules: proc(none, async () => (await import('../writing/tells')).loadTellRules()),
  stories: proc(none, async () => {
    const { listStories, storySeeds } = await import('../writing/stories')
    const { db, schema } = await dbm()
    const threads = db.select().from(schema.chatThreads).orderBy(desc(schema.chatThreads.updatedAt)).limit(200).all().filter((t) => t.context?.mode === 'story').slice(0, 20)
    return { stories: listStories(), seeds: storySeeds(), threads: threads.map((t) => ({ id: t.id, title: t.title, updatedAt: t.updatedAt })) }
  }),

  // ------------------------------------------------------------------ settings
  settings: proc(none, async () => {
    const { getSettings } = await settingsm()
    const { hasSecret } = await import('../secrets')
    const { config } = await import('../config')
    return { settings: getSettings(), secrets: { hunter: hasSecret('hunter-api-key'), ntfy: hasSecret('ntfy-token') }, mode: config.mode, home: config.home, version: (await import('../version')).VERSION, build: (await import('../version')).BUILD }
  }),
  saveSettings: proc(z.object({ settings: z.record(z.string(), z.unknown()) }), async ({ settings }) => {
    const { saveSettings, AppSettings } = await settingsm()
    saveSettings(AppSettings.parse(settings))
    return { ok: true }
  }),
  updateSettings: proc(z.object({ section: z.string(), patch: z.record(z.string(), z.unknown()) }), async ({ section, patch }) => {
    const { updateSettings } = await settingsm()
    updateSettings(section as never, patch as never)
    return { ok: true }
  }),
  setSecret: proc(z.object({ name: z.enum(['hunter-api-key', 'ntfy-token']), value: z.string() }), async ({ name, value }) => {
    ;(await import('../secrets')).setSecret(name, value.trim())
    return { ok: true }
  }),
  /** Apply the structured search choices: regenerate the scout's title and location filters. */
  applySearch: proc(none, async () => {
    const { getSettings, updateSettings } = await settingsm()
    const { buildLocationFilters, buildTitleFilters } = await import('../scout/filters')
    const s = getSettings()
    const titles = buildTitleFilters(s.search.roles, s.search.seniority)
    const loc = buildLocationFilters(s.you.country, s.search.locations)
    updateSettings('scout', { ...titles, ...loc })
    return { ...titles, ...loc }
  }),
  testNotification: proc(none, async () => {
    const { notifyPromise } = await import('../notify')
    return notifyPromise({ kind: 'test', title: 'Sidedoor is connected', body: 'Strong new jobs, packages ready to review, and follow-ups will show up here.', path: '/', priority: 4 })
  }),
  access: proc(none, async () => {
    const { accessToken } = await import('./auth')
    const { config } = await import('../config')
    const { getSettings } = await settingsm()
    const { lanAddresses } = await import('./net')
    const s = getSettings().app
    const token = accessToken()
    const bases = [s.publicUrl, ...(s.allowNetwork ? lanAddresses().map((ip) => `http://${ip}:${config.port}`) : [])].filter(Boolean)
    return { links: bases.map((b) => `${b.replace(/\/$/, '')}/pair#token=${token}`), allowNetwork: s.allowNetwork, publicUrl: s.publicUrl, listening: config.host }
  }),
  rotateAccess: proc(none, async () => {
    ;(await import('./auth')).rotateAccessToken()
    return { ok: true }
  }),

  // ------------------------------------------------------------------ AI connections
  aiStatus: proc(z.object({ force: z.boolean().optional() }).optional(), async (i) => {
    const ai = await import('../ai')
    const { connectionStatus } = await import('../ai/connect')
    const { getSettings } = await settingsm()
    const statuses = await ai.providerStatuses(i?.force ?? false)
    const connected = await connectionStatus(statuses)
    return { providers: statuses.map((s) => ({ ...s, connected: connected[s.id] ?? false })), default: getSettings().ai.default, jobs: getSettings().ai.jobs }
  }),
  setDefaultAi: proc(z.object({ provider: ProviderId.nullable() }), async ({ provider }) => {
    ;(await settingsm()).updateSettings('ai', { default: provider })
    return { ok: true }
  }),
  setJobAi: proc(z.object({ job: z.string(), provider: ProviderId.nullable(), model: z.string() }), async ({ job, provider, model }) => {
    const { getSettings, updateSettings } = await settingsm()
    updateSettings('ai', { jobs: { ...getSettings().ai.jobs, [job]: { provider, model } } })
    return { ok: true }
  }),
  /** Quick end-to-end check: a tiny JSON job on the provider. */
  testAi: proc(z.object({ provider: ProviderId }), async ({ provider }) => {
    const { runJob } = await import('../ai')
    const started = Date.now()
    const r = await runJob({ job: 'triage', provider, prompt: 'Reply with {"ok": true, "word": "<one word that describes a good job search>"}.', schema: z.object({ ok: z.boolean(), word: z.string() }), maxTurns: 2, timeoutMs: 120_000 })
    return { ok: r.data.ok, word: r.data.word, ms: Date.now() - started, model: r.model }
  }),
  /** Register Sidedoor's MCP server in the user's own CLI, so their sessions can use the app. */
  connectAi: proc(z.object({ provider: ProviderId, connect: z.boolean() }), async ({ provider, connect }) => {
    const c = await import('../ai/connect')
    return connect ? c.connectProvider(provider) : c.disconnectProvider(provider)
  }),
  connectInfo: proc(none, async () => (await import('../ai/connect')).connectInfo()),

  // ------------------------------------------------------------------ onboarding + profile
  docs: proc(none, async () => {
    const d = await docs()
    return Object.entries(d.DOCS).map(([key, meta]) => {
      const doc = d.getDoc(key as never)
      return { key, ...meta, updatedAt: doc.updatedAt, written: d.isWritten(key as never), chars: doc.body.length }
    })
  }),
  doc: proc(z.object({ key: DocKey }), async ({ key }) => {
    const d = await docs()
    return { ...d.getDoc(key), ...d.DOCS[key], template: d.defaultDoc(key) }
  }),
  saveDoc: proc(z.object({ key: DocKey, body: z.string() }), async ({ key, body }) => {
    if (key === 'tells') JSON.parse(body)
    ;(await docs()).setDoc(key, body)
    return { ok: true }
  }),
  completeOnboarding: proc(z.object({ done: z.boolean() }), async ({ done }) => {
    const { updateSettings } = await settingsm()
    updateSettings('onboarding', { completedAt: done ? new Date().toISOString() : null })
    if (done) await scoutNow()
    const { db, schema } = await dbm()
    const sources = db.select({ id: schema.sources.id }).from(schema.sources).where(eq(schema.sources.status, 'active')).all().length
    return { ok: true, sources }
  }),
  starterSources: proc(none, async () => (await import('../scout/catalog')).catalogForUser()),
  addStarterSources: proc(z.object({ ids: z.array(z.string()) }), async ({ ids }) => {
    const n = (await import('../scout/catalog')).addCatalogSources(ids)
    await scoutNow()
    return { added: n }
  }),

  // ------------------------------------------------------------------ resumes
  resumes: proc(none, async () => (await resumes()).listResumes()),
  resume: proc(id, async ({ id }) => {
    const m = await resumes()
    const r = m.requireResume(id)
    return { resume: r, changes: m.resumeChanges(r), match: (await q()).getResumeMatch(id) }
  }),
  createResume: proc(z.object({ title: z.string().min(1), theme: z.string().optional(), copyFrom: z.string().optional() }), async ({ title, theme, copyFrom }) => {
    const m = await resumes()
    const src = copyFrom ? m.requireResume(copyFrom) : undefined
    const r = m.createResume({ title, ...(theme ? { theme } : src ? { theme: src.theme } : {}), ...(src ? { content: src.content, themeOptions: src.themeOptions } : {}) })
    return { id: r.id }
  }),
  saveResume: proc(z.object({ id: z.string(), content: z.record(z.string(), z.unknown()), baseVersion: z.number() }), async ({ id, content, baseVersion }) => {
    const r = (await resumes()).saveContent(id, content as unknown as ResumeContent, { by: 'user', baseVersion })
    return r.ok ? { ok: true as const, version: r.resume.version } : { ok: false as const, conflict: true, version: r.resume.version }
  }),
  setResumeLines: proc(z.object({ id: z.string(), lines: z.record(z.string(), z.string()), baseVersion: z.number().optional() }), async ({ id, lines, baseVersion }) => {
    const r = (await resumes()).setLines(id, lines, { by: 'user', ...(baseVersion !== undefined ? { baseVersion } : {}) })
    return r.ok ? { ok: true as const, version: r.resume.version } : { ok: false as const, conflict: true, version: r.resume.version }
  }),
  resumeReview: proc(z.object({ id: z.string(), action: z.enum(['keep', 'undo', 'keep-all', 'undo-all']), lineId: z.string().optional() }), async ({ id, action, lineId }) => {
    ;(await resumes()).reviewAction(id, action, lineId)
    return { ok: true }
  }),
  setResumeTheme: proc(z.object({ id: z.string(), theme: z.string(), options: ThemeOptions.optional() }), async ({ id, theme, options }) => {
    ;(await resumes()).setTheme(id, theme, options)
    return { ok: true }
  }),
  renameResume: proc(z.object({ id: z.string(), title: z.string().min(1) }), async ({ id, title }) => {
    ;(await resumes()).renameResume(id, title)
    return { ok: true }
  }),
  deleteResume: proc(id, async ({ id }) => {
    ;(await resumes()).deleteResume(id)
    return { ok: true }
  }),
  buildResumePdf: proc(id, async ({ id }) => {
    const r = await (await resumes()).buildResumePdf(id)
    return { file: r.file, pages: r.pages }
  }),
  resumeNote: proc(
    z.object({ id: z.string(), action: z.enum(['add', 'reply', 'status']), noteId: z.string().optional(), target: z.string().nullable().optional(), quote: z.string().optional(), text: z.string().optional(), status: z.enum(['open', 'answered', 'applied', 'resolved']).optional() }),
    async ({ id, ...v }) => (await resumes()).noteAction(id, { ...v, who: 'user' }),
  ),
  askAiAboutNotes: proc(id, async ({ id }) => {
    const r = (await resumes()).requireResume(id)
    const t = (await tasks()).enqueueTask('resume-notes', `Answer resume notes: ${r.title}`, { input: { resumeId: id }, priority: 10 })
    return { taskId: t.id }
  }),
  resumeVersions: proc(id, async ({ id }) => (await resumes()).versionsOf(id)),
  restoreResumeVersion: proc(z.object({ id: z.string(), versionId: z.string() }), async ({ id, versionId }) => {
    ;(await resumes()).restoreVersion(id, versionId)
    return { ok: true }
  }),
  /** Import an existing resume from text (the upload route extracts text from PDF/DOCX first). */
  importResume: proc(z.object({ text: z.string().min(1), resumeId: z.string().optional(), theme: z.string().optional() }), async ({ text, resumeId, theme }) => {
    const t = (await tasks()).enqueueTask('import-resume', 'Import your resume', { input: { text, ...(resumeId ? { resumeId } : {}), ...(theme ? { theme } : {}) }, priority: 20 })
    return { taskId: t.id }
  }),
  task: proc(id, async ({ id }) => {
    const { db, schema } = await dbm()
    return db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get() ?? null
  }),

  // ------------------------------------------------------------------ writes
  trackPosting: proc(z.object({ id: z.string(), prep: z.boolean().optional(), research: z.boolean().optional() }), async ({ id, prep, research }) => {
    const a = (await apps()).trackPosting(id, { ...(prep !== undefined ? { prep } : {}), ...(research !== undefined ? { research } : {}) })
    return { id: a.id }
  }),
  setPostingStatus: proc(z.object({ id: z.string(), status: z.enum(['new', 'starred', 'dismissed']) }), async ({ id, status }) => {
    const { db, schema } = await dbm()
    db.update(schema.postings).set({ userStatus: status }).where(eq(schema.postings.id, id)).run()
    return { ok: true }
  }),
  setStage: proc(z.object({ id: z.string(), stage: Stage, closedReason: z.string().optional(), won: z.boolean().optional(), note: z.string().optional() }), async (d) => {
    const m = await apps()
    m.setStage(d.id, d.stage, { ...(d.closedReason ? { closedReason: d.closedReason } : {}), ...(d.won ? { won: true } : {}), ...(d.note ? { note: d.note } : {}) })
    return { ok: true }
  }),
  requestChanges: proc(z.object({ id: z.string(), notes: z.string().min(1) }), async ({ id, notes }) => {
    ;(await apps()).requestChanges(id, notes)
    return { ok: true }
  }),
  /** You checked: the listing is still up. Reopen it; the scout closes it again if it stays missing a day. */
  listingStillOpen: proc(z.object({ postingId: z.string() }), async ({ postingId }) => {
    const { db, schema } = await dbm()
    db.update(schema.postings).set({ closedAt: null, lastSeenAt: new Date().toISOString() }).where(eq(schema.postings.id, postingId)).run()
    return { ok: true }
  }),
  /** Settle one decision (fine as is, or with your answer) against the package as it is now. */
  setDecision: proc(z.object({ id: z.string(), text: z.string(), done: z.boolean(), answer: z.string().max(2000).nullable().optional() }), async ({ id, text, done, answer }) => {
    const a = await apps()
    const { decisionsOf, setDecisionLine } = await import('@sidedoor/shared/decisions')
    const app = a.getApplication(id)
    if (!app?.packageMd) throw new Error('No package')
    const d = decisionsOf(app.packageMd).find((x) => x.text === text)
    if (!d) throw new Error('That decision changed; reload the package')
    a.updateApplication(id, { packageMd: setDecisionLine(app.packageMd, d.line, done, answer) })
    return { ok: true }
  }),
  updateApplication: proc(
    z.object({
      id: z.string(),
      patch: z
        .object({
          companyName: z.string(),
          role: z.string(),
          priority: z.enum(['high', 'medium', 'low']),
          status: z.enum(['potential', 'active', 'on-hold', 'closed-won', 'closed-lost']),
          nextAction: z.string().nullable(),
          nextActionDate: z.string().nullable(),
          jobUrl: z.string().nullable(),
          applyUrl: z.string().nullable(),
          location: z.string().nullable(),
          compText: z.string().nullable(),
          notesMd: z.string().nullable(),
          packageMd: z.string().nullable(),
        })
        .partial(),
    }),
    async ({ id, patch }) => {
      const m = await apps()
      const { status, ...rest } = patch
      m.updateApplication(id, rest)
      // Closing goes through the stage, so the pipeline and the status never disagree.
      if (status === 'closed-won' || status === 'closed-lost') m.setStage(id, 'closed', { won: status === 'closed-won', closedReason: status === 'closed-won' ? 'Won' : 'Closed' })
      else if (status) m.updateApplication(id, { status })
      return { ok: true }
    },
  ),
  createApplication: proc(
    z.object({ companyName: z.string().min(1), role: z.string().min(1), jobUrl: z.string().optional(), source: z.string().optional(), research: z.boolean().optional(), prep: z.boolean().optional() }),
    async (d) => {
      const { ensureCompany, domainOf } = await import('../companies')
      const c = ensureCompany(d.companyName, { domain: domainOf(d.jobUrl) })
      const m = await apps()
      const a = m.createApplication({ companyId: c.id, companyName: c.name, role: d.role, jobUrl: d.jobUrl ?? null, applyUrl: d.jobUrl ?? null, source: d.source ?? 'manual', stage: 'interested', status: 'active', lastActivityAt: new Date().toISOString() })
      const t = await tasks()
      if (d.prep) t.enqueueTask('prep', `Prepare package: ${c.name} – ${d.role}`, { applicationId: a.id, priority: 10 })
      if (d.research) t.enqueueTask('research', `Research & people: ${c.name} – ${d.role}`, { applicationId: a.id, priority: 10 })
      return { id: a.id }
    },
  ),
  startTask: proc(
    z.object({ kind: z.enum(['research', 'prep', 'outreach', 'discover', 'funding', 'custom', 'submit-assist', 'match', 'x-scout']), applicationId: z.string().optional(), personId: z.string().optional(), instructions: z.string().optional(), title: z.string().optional() }),
    async (d) => {
      const t = await tasks()
      const m = await apps()
      const a = d.applicationId ? m.getApplication(d.applicationId) : undefined
      const label = d.title ?? (a ? `${a.companyName} – ${a.role}` : (d.instructions?.slice(0, 70) ?? d.kind))
      const verb = { 'submit-assist': 'Fill form', match: 'Check resume match', 'x-scout': 'Research on X' }[d.kind as string] ?? `${d.kind[0]!.toUpperCase()}${d.kind.slice(1)}`
      const task = t.enqueueTask(d.kind, `${verb}: ${label}`, { applicationId: d.applicationId ?? null, personId: d.personId ?? null, priority: 10, input: d.instructions ? { instructions: d.instructions } : {} })
      return { id: task.id }
    },
  ),
  retryTask: proc(id, async ({ id }) => {
    ;(await tasks()).retryTask(id)
    return { ok: true }
  }),
  cancelTask: proc(id, async ({ id }) => {
    ;(await tasks()).cancelTask(id)
    return { ok: true }
  }),
  savePerson: proc(PersonInput, async (d) => {
    const { id, applicationId, role, ...rest } = d
    const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as typeof rest
    const m = await people()
    if (id) {
      m.updatePerson(id, clean as never)
      if (applicationId) m.linkPerson(applicationId, id, role)
      return { id }
    }
    const p = m.upsertPerson({ ...clean, name: rest.name } as never, { ...(applicationId ? { applicationId } : {}), ...(role ? { role } : {}) })
    return { id: p.id }
  }),
  logInteraction: proc(
    z.object({ personId: z.string().optional(), applicationId: z.string().optional(), channel: z.string(), direction: z.enum(['out', 'in', 'note']), summary: z.string().min(1), nextContactInDays: z.number().nullable().optional() }),
    async (d) => {
      ;(await people()).logInteraction({ ...d, personId: d.personId ?? null, applicationId: d.applicationId ?? null, nextContactInDays: d.nextContactInDays ?? null })
      return { ok: true }
    },
  ),
  scheduleFollowup: proc(z.object({ personId: z.string().optional(), applicationId: z.string().optional(), date: z.string().nullable(), action: z.string().optional() }), async (d) => {
    ;(await people()).scheduleFollowup(d)
    return { ok: true }
  }),
  saveDraft: proc(
    z.object({ id: z.string().optional(), personId: z.string().nullable().optional(), applicationId: z.string().nullable().optional(), toEmail: z.string().nullable().optional(), subject: z.string().nullable().optional(), body: z.string(), channel: z.string().optional() }),
    async (d) => {
      const m = await people()
      if (d.id) {
        m.updateDraft(d.id, { body: d.body, ...(d.subject !== undefined ? { subject: d.subject } : {}), ...(d.toEmail !== undefined ? { toEmail: d.toEmail } : {}), ...(d.personId !== undefined ? { personId: d.personId } : {}), ...(d.channel ? { channel: d.channel } : {}) })
        return { id: d.id }
      }
      const r = m.createDraft({ ...d, author: 'user' })
      return { id: r.id }
    },
  ),
  draftSent: proc(z.object({ id: z.string(), nextContactInDays: z.number().optional() }), async ({ id, nextContactInDays }) => {
    ;(await people()).markDraftSent(id, nextContactInDays)
    return { ok: true }
  }),
  discardDraft: proc(id, async ({ id }) => {
    ;(await people()).discardDraft(id)
    return { ok: true }
  }),
  editDraft: proc(id, async ({ id }) => {
    const r = await (await import('../writing/editor')).editDrafts([id])
    if (r.error) throw new Error(`Editor pass failed: ${r.error.slice(0, 200)}`)
    return { edited: r.edited }
  }),
  editPackage: proc(id, async ({ id }) => {
    const r = await (await import('../writing/editor')).editPackage(id)
    if (r.error) throw new Error(`Editor pass failed: ${r.error.slice(0, 200)}`)
    return { edited: r.edited }
  }),
  startStoryInterview: proc(z.object({ seed: z.string().optional(), role: z.string().optional() }), async ({ seed, role }) => {
    const { startTurn } = await import('../chat')
    const message = seed
      ? `Interview me about this${role ? ` (${role})` : ''}:\n\n${seed}`
      : 'Pick a role or achievement from my Experience document that has a number or a hard decision behind it and is not in my story bank yet, and interview me about it.'
    return startTurn({ message, mode: 'story', title: `Story: ${seed ?? 'your AI picks'}` })
  }),
  findEmail: proc(z.object({ personId: z.string(), domain: z.string() }), async ({ personId, domain }) => {
    const { findEmailFor } = await import('../services/email-finder')
    const p = (await people()).getPerson(personId)
    if (!p) throw new Error('not found')
    const { db, schema } = await dbm()
    const company = p.companyId ? db.select().from(schema.companies).where(eq(schema.companies.id, p.companyId)).get() : undefined
    if (company && !company.domain) db.update(schema.companies).set({ domain }).where(eq(schema.companies.id, company.id)).run()
    return findEmailFor({ name: p.name, domain, companyId: p.companyId, personId: p.id })
  }),
  /** A delivery failure: record it, then look for the next most likely address. */
  emailBounced: proc(z.object({ personId: z.string(), email: z.string().nullable().optional() }), async ({ personId, email }) => {
    const svc = await people()
    const b = svc.markEmailBounced(personId, email)
    if (b.current) return { bounced: b.bounced, next: null, current: b.current, resendDraftId: null }
    const { findEmailFor } = await import('../services/email-finder')
    const r = await findEmailFor({ name: b.name, domain: b.domain, companyId: b.companyId, personId: b.personId }).catch(() => null)
    const next = r?.candidates[0] ?? null
    if (next) svc.setRetryEmail({ personId: b.personId, email: next.email, confidence: next.confidence, source: `${next.source} (after ${b.bounced} bounced)`, draftId: b.resendDraftId })
    return { bounced: b.bounced, next, current: null, resendDraftId: b.resendDraftId }
  }),
  addSource: proc(z.object({ url: z.string().min(2), companyName: z.string().optional(), hot: z.boolean().optional() }), async (d) => {
    const { detectAts, probeBoard } = await import('../scout/adapters')
    const { ensureCompany } = await import('../companies')
    const { db, schema } = await dbm()
    const { newId } = await import('../ids')
    let det: { kind: string; board: string } | null = detectAts(d.url)
    if (!det && /rss|feed|\.xml/i.test(d.url)) det = { kind: 'rss', board: d.url }
    if (!det && !/[/.]/.test(d.url)) {
      const r = await Effect.runPromise(probeBoard(d.url.trim()))
      if (r) det = { kind: r.kind, board: r.board }
    }
    if (!det) throw new Error('Could not find a Greenhouse, Lever, Ashby, Workable or SmartRecruiters board or an RSS feed in that. Paste the board URL, or just the company’s board name.')
    const company = d.companyName ? ensureCompany(d.companyName, { atsKind: det.kind, atsBoard: det.board }) : det.kind !== 'rss' ? ensureCompany(det.board, { atsKind: det.kind, atsBoard: det.board }) : null
    db.insert(schema.sources)
      .values({ id: newId('src_'), name: company?.name ?? det.board, kind: det.kind, board: det.board, url: d.url, companyId: company?.id ?? null, status: 'active', tier: d.hot ? 'hot' : 'normal', origin: 'manual' })
      .onConflictDoUpdate({ target: [schema.sources.kind, schema.sources.board], set: { status: 'active', ...(d.hot ? { tier: 'hot' as const } : {}) } })
      .run()
    await scoutNow()
    return det
  }),
  updateSource: proc(z.object({ id: z.string(), status: z.enum(['active', 'candidate', 'paused', 'rejected']).optional(), tier: z.enum(['hot', 'normal']).optional() }), async ({ id, ...patch }) => {
    const { db, schema } = await dbm()
    db.update(schema.sources).set(patch).where(eq(schema.sources.id, id)).run()
    return { ok: true }
  }),
  setCompanyInterest: proc(z.object({ id: z.string(), interest: z.number().min(-1).max(2) }), async ({ id, interest }) => {
    const { db, schema } = await dbm()
    db.update(schema.companies).set({ interest }).where(eq(schema.companies.id, id)).run()
    // Dream companies are polled on the fast interval.
    db.update(schema.sources).set({ tier: interest >= 2 ? 'hot' : 'normal' }).where(eq(schema.sources.companyId, id)).run()
    return { ok: true }
  }),
  watchCompany: proc(id, async ({ id }) => {
    const { db, schema } = await dbm()
    const { attachBoard } = await import('../jobs/tasks')
    const c = db.select().from(schema.companies).where(eq(schema.companies.id, id)).get()
    if (!c) throw new Error('not found')
    const kind = await attachBoard(c, c.website, 'manual')
    if (!kind) throw new Error(`Couldn't find a public job board for ${c.name}. Add it on the Sources page.`)
    await scoutNow()
    return { kind }
  }),
  /** Follow-ups more than `days` overdue stop being due (they've gone stale); nothing else changes. */
  /**
   * Tidy follow-ups that went stale: untouched Interested applications are archived (closed), the
   * rest just lose their overdue date. Returns what changed so the client can undo it.
   */
  clearStaleFollowups: proc(z.object({ days: z.number().min(7).default(21) }), async ({ days }) => {
    const { db, schema } = await dbm()
    const { lt, and, isNotNull, inArray } = await import('drizzle-orm')
    const { addDays, today } = await import('../ids')
    const cutoff = addDays(today(), -days)
    const m = await people()
    const a = await apps()
    const undo: { people: Array<{ id: string; date: string }>; apps: Array<{ id: string; date: string; archived: boolean; status: 'potential' | 'active' | 'on-hold'; nextAction: string | null }> } = { people: [], apps: [] }
    for (const p of db.select({ id: schema.people.id, date: schema.people.nextContactAt }).from(schema.people).where(and(isNotNull(schema.people.nextContactAt), lt(schema.people.nextContactAt, cutoff))).all()) {
      m.scheduleFollowup({ personId: p.id, date: null })
      undo.people.push({ id: p.id, date: p.date! })
    }
    const A = schema.applications
    // The same applications Today lists as due (getToday), and no others.
    const due = and(isNotNull(A.nextActionDate), lt(A.nextActionDate, cutoff), inArray(A.status, ['potential', 'active']), inArray(A.stage, ['applied', 'screening', 'interviewing', 'offer', 'interested']))
    for (const x of db.select({ id: A.id, date: A.nextActionDate, stage: A.stage, status: A.status, nextAction: A.nextAction }).from(A).where(due).all()) {
      const archived = x.stage === 'interested'
      if (archived) a.setStage(x.id, 'closed', { closedReason: 'Archived: untouched', note: `No action for ${days}+ days` })
      else a.updateApplication(x.id, { nextActionDate: null })
      // `due` only matches potential and active applications.
      undo.apps.push({ id: x.id, date: x.date!, archived, status: x.status as 'potential' | 'active', nextAction: x.nextAction })
    }
    return { archived: undo.apps.filter((x) => x.archived).length, cleared: undo.people.length + undo.apps.filter((x) => !x.archived).length, undo }
  }),
  undoClearStale: proc(
    z.object({
      people: z.array(z.object({ id: z.string(), date: z.string() })),
      apps: z.array(z.object({ id: z.string(), date: z.string(), archived: z.boolean(), status: z.enum(['potential', 'active', 'on-hold']), nextAction: z.string().nullable() })),
    }),
    async (u) => {
      const m = await people()
      const a = await apps()
      for (const p of u.people) m.scheduleFollowup({ personId: p.id, date: p.date })
      for (const x of u.apps) a.updateApplication(x.id, x.archived ? { stage: 'interested', status: x.status, closedReason: null, nextAction: x.nextAction, nextActionDate: x.date } : { nextActionDate: x.date })
      return { ok: true }
    },
  ),
  runScoutNow: proc(none, async () => {
    await scoutNow()
    return { ok: true }
  }),
  setPaused: proc(z.object({ paused: z.boolean() }), async ({ paused }) => {
    ;(await settingsm()).updateSettings('worker', { paused })
    return { ok: true }
  }),
}

export type Router = typeof router
export type RpcName = keyof Router
