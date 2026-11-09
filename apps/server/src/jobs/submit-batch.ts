import { and, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { decisionsOf } from '@sidedoor/shared/decisions'
import { stillOpen, writingItems } from '@sidedoor/shared/review'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { newId, nowIso } from '../ids'
import { notifyPromise } from '../notify'
import { forWhom, getApplication, requestSubmit, submitterAllowed, updateApplication } from '../services/applications'
import { listQuestions } from '../services/questions'
import { getResume } from '../services/resumes'
import { cancelTask, enqueueTask } from '../services/tasks'
import { getMeta, getSettings, setMeta } from '../settings'
import { truncate } from '../text'
import { type ApplyTarget, resolveApplyTarget } from './apply-url'
import { type Evidence, submissionOf, type Submission } from './fill-form'

/**
 * A batch: a list of applications sent through the one fill path (jobs/fill-form.ts), one at a
 * time. Each gets its turn only when the one before it is done, so there is never more than one
 * form filling, a pause or cancel stops before the next form opens, and each turn checks the
 * company's limit against what has actually gone in by then. Batches live in the meta store
 * (live in the app like settings); the tasks they queue hold the real outcomes.
 */

export const BATCH_MODES = ['dry-run', 'fill', 'submit'] as const
export type BatchMode = (typeof BATCH_MODES)[number]
export const BATCH_ORDERS = ['given', 'priority', 'score', 'posted'] as const
export type BatchOrder = (typeof BATCH_ORDERS)[number]
export type BlockedBy = 'login' | 'captcha' | 'limit' | 'rule' | 'review' | 'email' | 'other'
export type BatchBy = 'agent' | 'grokbot'
export type ItemStatus = 'pending' | Submission['status']

export interface CompanyLimit {
  company: string
  max: number
  days: number
}

interface BatchItem {
  applicationId: string
  application: string
  companyId: string | null
  company: string
  /** When its turn came. */
  startedAt?: string
  /** The fill task it was sent as. */
  taskId?: string
  /** Its turn is over: the fill ended, or it never got one. */
  done?: boolean
  /** Why it got no fill. */
  stopped?: { status: 'blocked' | 'failed' | 'cancelled'; blockedBy?: BlockedBy; summary: string }
  /** What Sidedoor did on the way, e.g. the apply link it found. */
  note?: string
}

export interface SubmitBatch {
  id: string
  mode: BatchMode
  /** Who started it. Batches from before your AI could submit have none: they were Grok Bot's. */
  by?: BatchBy
  order: BatchOrder
  status: 'running' | 'paused' | 'done' | 'cancelled'
  /** Send more than one role at the same company in this batch. */
  allowSameCompany: boolean
  /** Send the base resume when an application has no tailored one. */
  allowBaseResume: boolean
  /** Limits for this batch, on top of (and ahead of) the ones in Settings. */
  limits: CompanyLimit[]
  /** Why it paused itself, when it did. */
  note: string | null
  createdAt: string
  updatedAt: string
  finishedAt: string | null
  items: BatchItem[]
}

const KEY = 'submitBatches'
const KEEP = 20

export const listBatches = (): SubmitBatch[] => getMeta<SubmitBatch[]>(KEY) ?? []
export const getBatch = (id?: string) => (id ? listBatches().find((b) => b.id === id) : listBatches()[0])
const save = (b: SubmitBatch) => {
  const rest = listBatches().filter((x) => x.id !== b.id)
  setMeta(KEY, [{ ...b, updatedAt: nowIso() }, ...rest].sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, KEEP))
}
/** Change a batch as it is stored now (it may have been paused while a page was being read). */
const change = (id: string, fn: (b: SubmitBatch) => void) => {
  const b = getBatch(id)
  if (!b) throw new Error(`No batch ${id}`)
  fn(b)
  save(b)
  return b
}

// --- ordering and limits ---------------------------------------------------------------------

const PRIORITY = { high: 0, medium: 1, low: 2 } as const
type Orderable = Pick<schema.Application, 'id' | 'priority' | 'rank' | 'fitScore' | 'shot' | 'createdAt'> & { postedAt?: string | null }

const desc0 = (x: number | null | undefined, y: number | null | undefined) => (y ?? -1) - (x ?? -1)

/**
 * The order a batch sends applications in. given: as listed. priority: high first, then your
 * rank within the stage, then fit. score: fit score, then chance of an interview. posted: the
 * newest listing first. Ties go by fit, then oldest application first.
 */
export const orderApplications = <T extends Orderable>(apps: T[], order: BatchOrder): T[] => {
  if (order === 'given') return [...apps]
  const tie = (x: T, y: T) => desc0(x.fitScore, y.fitScore) || x.createdAt.localeCompare(y.createdAt)
  const by: Record<Exclude<BatchOrder, 'given'>, (x: T, y: T) => number> = {
    priority: (x, y) => PRIORITY[x.priority] - PRIORITY[y.priority] || (x.rank ?? Infinity) - (y.rank ?? Infinity) || tie(x, y),
    score: (x, y) => desc0(x.fitScore, y.fitScore) || desc0(x.shot, y.shot) || x.createdAt.localeCompare(y.createdAt),
    posted: (x, y) => (y.postedAt ?? '').localeCompare(x.postedAt ?? '') || tie(x, y),
  }
  return [...apps].sort(by[order])
}

/** A company's name as limits and the same-company rule compare it. */
export const companyNorm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[,.]?\s+(inc|llc|ltd|corp|co|gmbh|labs?|technologies|hq)\.?$/g, '')
    .replace(/[^a-z0-9]+/g, '')

const sameCompany = (x: { companyId: string | null; company: string }, y: { companyId: string | null; company: string }) =>
  (!!x.companyId && x.companyId === y.companyId) || companyNorm(x.company) === companyNorm(y.company)

/** The limit for a company: the batch's own first, then Settings; '*' is everyone else's. */
export const limitFor = (company: string, limits: CompanyLimit[]) =>
  limits.find((l) => l.company !== '*' && companyNorm(l.company) === companyNorm(company)) ?? limits.find((l) => l.company === '*') ?? null

/**
 * Why sending this item would break its company's limit, or null. Counts applications that went
 * in within the window (appliedAt), plus the ones this batch already sent there: a form waiting
 * on answers may still go in.
 */
export const limitProblem = (b: Pick<SubmitBatch, 'items' | 'limits'>, item: BatchItem, now = new Date()): string | null => {
  const limit = limitFor(item.company, [...b.limits, ...getSettings().grokBot.companyLimits])
  if (!limit) return null
  const since = new Date(now.getTime() - limit.days * 86_400_000).toISOString()
  const ours = new Set(b.items.map((i) => i.applicationId))
  const A = schema.applications
  const before = db
    .select({ id: A.id, companyId: A.companyId, company: A.companyName })
    .from(A)
    .where(and(isNotNull(A.appliedAt), gte(A.appliedAt, since)))
    .all()
    .filter((a) => !ours.has(a.id) && sameCompany(a, item)).length
  const inBatch = b.items.filter((i) => i !== item && i.startedAt && !i.stopped && sameCompany(i, item)).length
  const n = before + inBatch
  return n >= limit.max ? `${item.company} limit: ${limit.max} per ${limit.days} days, and ${n} went in already${inBatch ? ` (${inBatch} in this batch)` : ''}.` : null
}

// --- starting and steering -------------------------------------------------------------------

/** The same limit for one application sent on its own, by Approve & submit. */
export const companyLimitProblem = (a: Pick<schema.Application, 'id' | 'companyId' | 'companyName'>) =>
  limitProblem({ items: [], limits: [] }, { applicationId: a.id, companyId: a.companyId, company: a.companyName } as BatchItem)

export interface BatchFilter {
  /** Default: approved. */
  stages?: schema.ApplicationStage[]
  minScore?: number
  max?: number
}

export interface StartBatch {
  mode: BatchMode
  /** Default: grokbot. */
  by?: BatchBy
  applicationIds?: string[]
  filter?: BatchFilter
  /** Default: given for a list of ids, priority for a filter. */
  order?: BatchOrder
  allowSameCompany?: boolean
  allowBaseResume?: boolean
  limits?: CompanyLimit[]
}

const UNSENT: schema.ApplicationStage[] = ['interested', 'review', 'approved']
const byOf = (b: Pick<SubmitBatch, 'by'>): BatchBy => b.by ?? 'grokbot'
const SUBMIT_OFF: Record<BatchBy, { who: string; where: string }> = {
  agent: { who: 'your AI', where: 'Settings → AI' },
  grokbot: { who: 'Grok Bot', where: 'Settings → AI → Grok Bot' },
}

/** Start a batch. One at a time: a batch that is running or paused has to finish or be cancelled first. */
export const startBatch = (o: StartBatch) => {
  const open = listBatches().find((b) => b.status === 'running' || b.status === 'paused')
  if (open) throw new Error(`Batch ${open.id} is ${open.status}. Cancel it (or let it finish) before starting another.`)
  const by = o.by ?? 'grokbot'
  if (o.mode === 'submit' && !submitterAllowed(by)) throw new Error(`Letting ${SUBMIT_OFF[by].who} submit is turned off (${SUBMIT_OFF[by].where}). Run a dry run, or ask the user to turn it on.`)
  const A = schema.applications
  let apps: schema.Application[]
  if (o.applicationIds?.length) {
    const ids = [...new Set(o.applicationIds)]
    const found = db.select().from(A).where(inArray(A.id, ids)).all()
    const missing = ids.filter((id) => !found.some((a) => a.id === id))
    if (missing.length) throw new Error(`No application ${missing.join(', ')}`)
    apps = ids.map((id) => found.find((a) => a.id === id)!)
  } else {
    const f = o.filter ?? {}
    apps = db
      .select()
      .from(A)
      .where(inArray(A.stage, f.stages?.length ? f.stages : ['approved']))
      .all()
      .filter((a) => !a.appliedAt && (f.minScore == null || (a.fitScore ?? 0) >= f.minScore))
  }
  const order = o.order ?? (o.applicationIds?.length ? 'given' : 'priority')
  const postings = new Map(
    db
      .select({ id: schema.postings.id, postedAt: schema.postings.postedAt, firstSeenAt: schema.postings.firstSeenAt })
      .from(schema.postings)
      .where(inArray(schema.postings.id, apps.map((a) => a.postingId).filter((x): x is string => !!x)))
      .all()
      .map((p) => [p.id, p.postedAt ?? p.firstSeenAt]),
  )
  const sorted = orderApplications(
    apps.map((a) => ({ ...a, postedAt: (a.postingId ? postings.get(a.postingId) : null) ?? null })),
    order,
  ).slice(0, o.filter?.max ?? Infinity)
  if (!sorted.length) throw new Error('No applications match. Give applicationIds, or a filter whose stages have some (default: approved).')
  const now = nowIso()
  const b: SubmitBatch = {
    id: newId('batch_'),
    mode: o.mode,
    by,
    order,
    status: 'running',
    allowSameCompany: o.allowSameCompany === true,
    allowBaseResume: o.allowBaseResume === true,
    limits: o.limits ?? [],
    note: null,
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    items: sorted.map((a) => ({ applicationId: a.id, application: `${a.companyName} – ${a.role}`, companyId: a.companyId, company: a.companyName })),
  }
  save(b)
  logActivity('application', `${o.mode === 'submit' ? 'Submitting' : o.mode === 'fill' ? 'Filling' : 'Dry run of'} ${b.items.length} application${b.items.length === 1 ? '' : 's'}${forWhom(by)}, one at a time`, { link: '/settings?section=ai' })
  return b
}

/** Hold the queued form back; a form already filling finishes. */
const holdCurrent = (b: SubmitBatch) => {
  const cur = b.items.find((i) => i.startedAt && !i.done)
  if (!cur?.taskId) return
  const t = db.select().from(schema.tasks).where(eq(schema.tasks.id, cur.taskId)).get()
  if (t?.status !== 'queued') return
  cancelTask(t.id)
  delete cur.startedAt
  delete cur.taskId
  delete cur.note
}

/** Pause: no next form opens, and a form still waiting its turn is held back. The one filling finishes. */
export const pauseBatch = (id: string, paused: boolean) =>
  change(id, (b) => {
    if (b.status === 'done' || b.status === 'cancelled') throw new Error(`Batch ${id} is ${b.status}.`)
    if (paused) holdCurrent(b)
    if (!paused && b.mode === 'submit' && !submitterAllowed(byOf(b))) throw new Error(`Letting ${SUBMIT_OFF[byOf(b)].who} submit is turned off (${SUBMIT_OFF[byOf(b)].where}).`)
    b.status = paused ? 'paused' : 'running'
    b.note = null
  })

/** Cancel: nothing more opens. A form filling right now finishes (and may still submit, once). */
export const cancelBatch = (id: string) =>
  change(id, (b) => {
    if (b.status === 'done' || b.status === 'cancelled') return
    holdCurrent(b)
    for (const i of b.items) if (!i.startedAt && !i.stopped) Object.assign(i, { done: true, stopped: { status: 'cancelled', summary: 'The batch was cancelled before its turn.' } })
    b.status = 'cancelled'
    b.finishedAt = nowIso()
  })

// --- the turn of each item -------------------------------------------------------------------

const stop = (item: BatchItem, status: 'blocked' | 'failed', summary: string, blockedBy?: BlockedBy) => {
  item.done = true
  item.stopped = { status, summary, ...(blockedBy ? { blockedBy } : {}) }
}

/** What stops an application before its form opens, or null. Doesn't touch anything. */
export const ruleProblem = (b: Pick<SubmitBatch, 'allowBaseResume'>, a: schema.Application | undefined): string | null => {
  if (!a) return 'The application was deleted.'
  if (a.appliedAt) return `Already applied on ${a.appliedAt.slice(0, 10)}.`
  if (!UNSENT.includes(a.stage)) return `It is in ${a.stage}, not waiting to go in.`
  if (!a.packageMd) return 'No application package yet: prep it first.'
  const p = a.postingId ? db.select({ closedAt: schema.postings.closedAt }).from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  if (p?.closedAt) return `The company took the listing down (${p.closedAt.slice(0, 10)}). Check it is still open, then send it on its own.`
  if (a.resumeId && !getResume(a.resumeId)) return 'Its tailored resume was deleted: tailor one again (prep).'
  if (!a.resumeId && !b.allowBaseResume) return 'No tailored resume for this application. Tailor one (prep), or start the batch with allowBaseResume to send the base resume.'
  return null
}

/**
 * What's left of the review before your AI may send this, or null. Your own press only warns
 * about these (they're your call), but an AI can't read for you: an essay nobody checked or a
 * question nobody answered waits for you, and a resume still being edited waits to be done.
 */
export const reviewHold = (a: schema.Application): string | null => {
  const T = schema.tasks
  const working = db.select({ id: T.id }).from(T).where(and(eq(T.applicationId, a.id), inArray(T.kind, ['prep', 'tune']), inArray(T.status, ['queued', 'running']))).get()
  if (working) return 'Your AI is still working on its package or resume. Send it once that is done.'
  const open = stillOpen({
    tuned: true,
    openQuestions: listQuestions({ status: 'open', applicationId: a.id }).filter((q) => !q.optional).length,
    openDecisions: decisionsOf(a.packageMd).filter((d) => !d.done).length,
    writingLeft: writingItems(a.packageMd, a.writingChecks).filter((w) => !w.done).length,
  })
  return open.length ? `Waiting on the user: ${open.join(', ')}.` : null
}

/** Why your AI can't send this one on its own right now, or null. A batch checks the same on each turn. */
export const agentSubmitProblem = (a: schema.Application) => ruleProblem({ allowBaseResume: false }, a) ?? reviewHold(a) ?? companyLimitProblem(a)

/** Give the next item its turn. Returns true when one was sent to be filled. */
const takeTurn = async (id: string, resolve: typeof resolveApplyTarget): Promise<boolean> => {
  const b = getBatch(id)
  const item = b?.items.find((i) => !i.startedAt && !i.done)
  if (!b || !item) return false
  if (b.mode === 'submit' && !submitterAllowed(byOf(b))) {
    change(id, (x) => {
      x.status = 'paused'
      x.note = `Paused: letting ${SUBMIT_OFF[byOf(b)].who} submit was turned off. Turn it on and resume, or cancel.`
    })
    return false
  }
  const a = getApplication(item.applicationId)
  const finish = (fn: (i: BatchItem) => void) => change(id, (x) => fn(x.items.find((i) => i.applicationId === item.applicationId)!))
  const rule = ruleProblem(b, a)
  if (rule || !a) {
    finish((i) => stop(i, 'blocked', rule ?? 'Not found.', 'rule'))
    return false
  }
  const hold = b.mode === 'submit' && byOf(b) === 'agent' ? reviewHold(a) : null
  if (hold) {
    finish((i) => stop(i, 'blocked', hold, 'review'))
    return false
  }
  const limit = limitProblem(b, item)
  if (limit) {
    finish((i) => stop(i, 'blocked', limit, 'limit'))
    return false
  }
  if (!b.allowSameCompany) {
    const first = b.items.find((i) => i !== item && i.startedAt && !i.stopped && sameCompany(i, item))
    if (first) {
      finish((i) => stop(i, 'blocked', `${first.application} already went in this batch; one role per company unless the batch allows more (allowSameCompany).`, 'limit'))
      return false
    }
  }
  const target: ApplyTarget = await resolve(a)
  // Paused or cancelled while the job page was read: leave it for later.
  if (getBatch(id)?.status !== 'running') return false
  if (target.kind === 'none') {
    finish((i) => stop(i, 'blocked', target.why, 'rule'))
    return false
  }
  if (target.kind === 'email') {
    updateApplication(a.id, { ...(a.applyUrl?.startsWith('mailto:') ? {} : { applyUrl: target.url }), nextAction: `Apply by email to ${target.email}: draft it; the user sends it` })
    finish((i) => stop(i, 'blocked', `It takes applications by email (${target.email}), not a form. Draft the email; the user sends it.`, 'email'))
    return false
  }
  if (target.resolved) updateApplication(a.id, { applyUrl: target.url })
  try {
    const t =
      b.mode === 'fill'
        ? enqueueTask('submit-assist', `Fill form: ${a.companyName} – ${a.role}`, { applicationId: a.id, priority: 10, input: { batchId: id } })
        : requestSubmit(a.id, { dryRun: b.mode === 'dry-run', by: byOf(b), batchId: id, closeWhenDone: true })
    // A fill-only turn that found a submit already waiting for it must not become that submit.
    if (b.mode === 'fill' && t.input.submit === true && t.input.dryRun !== true) throw new Error('This one was already sent to be submitted; that fill is waiting its turn.')
    finish((i) => Object.assign(i, { startedAt: nowIso(), taskId: t.id, ...(target.resolved ? { note: `Apply link found on the job page: ${target.url}` } : {}) }))
    return true
  } catch (e) {
    finish((i) => stop(i, 'failed', e instanceof Error ? e.message : String(e)))
    return false
  }
}

let advancing = false

/**
 * Move each running batch along: when its current form is done, the next item gets its turn.
 * Called every few seconds by the job runner. The page fetch for an apply link is the only wait.
 */
export const advanceBatches = async (resolve: typeof resolveApplyTarget = resolveApplyTarget) => {
  if (advancing) return
  advancing = true
  try {
    for (const b of listBatches().filter((x) => x.status === 'running')) {
      const cur = b.items.find((i) => i.startedAt && !i.done)
      if (cur) {
        const t = cur.taskId ? db.select({ status: schema.tasks.status }).from(schema.tasks).where(eq(schema.tasks.id, cur.taskId)).get() : undefined
        if (t && (t.status === 'queued' || t.status === 'running')) continue
        change(b.id, (x) => Object.assign(x.items.find((i) => i.applicationId === cur.applicationId)!, { done: true }))
      }
      // Skip past the ones that stop before a form opens, until one fills or none are left.
      while (getBatch(b.id)?.status === 'running' && getBatch(b.id)!.items.some((i) => !i.startedAt && !i.done)) {
        if (await takeTurn(b.id, resolve)) break
      }
      const now = getBatch(b.id)!
      if (now.status === 'running' && now.items.every((i) => i.done)) await finishBatch(now)
    }
  } finally {
    advancing = false
  }
}

const finishBatch = async (b: SubmitBatch) => {
  change(b.id, (x) => {
    x.status = 'done'
    x.finishedAt = nowIso()
  })
  const r = batchReport(b.id)!
  const line = Object.entries(r.counts)
    .map(([k, n]) => `${n} ${k.replace('_', ' ')}`)
    .join(', ')
  logActivity('application', `${byOf(b) === 'agent' ? 'Your AI' : 'Grok Bot'}'s batch is done: ${line}`, { link: '/settings?section=ai' })
  await notifyPromise({ kind: 'agent', title: `Batch done (${b.mode})`, body: line, path: '/settings?section=ai', priority: 3 })
}

// --- the report ------------------------------------------------------------------------------

export interface BatchItemReport {
  position: number
  applicationId: string
  application: string
  status: ItemStatus
  /** For blocked: what stopped it. */
  blockedBy?: BlockedBy
  summary: string
  questions: Submission['questions']
  evidence: Evidence | null
  taskId: string | null
  note?: string
}

/** What stopped a form, from what the fill or submit step said. */
export const blockedByOf = (summary: string): BlockedBy =>
  /captcha|recaptcha|hcaptcha|turnstile|are you (a )?human|robot/i.test(summary)
    ? 'captcha'
    : /sign[ -]?in|log[ -]?in|account|password|verify (your )?email|one-time code|\bsso\b/i.test(summary)
      ? 'login'
      : 'other'

const itemReport = (item: BatchItem, position: number): BatchItemReport => {
  const base = { position, applicationId: item.applicationId, application: item.application, questions: [], evidence: null, taskId: item.taskId ?? null, ...(item.note ? { note: item.note } : {}) }
  if (item.stopped) return { ...base, status: item.stopped.status, ...(item.stopped.blockedBy ? { blockedBy: item.stopped.blockedBy } : {}), summary: item.stopped.summary }
  if (!item.startedAt) return { ...base, status: 'pending', summary: 'Waiting for its turn.' }
  // Its latest fill: the batch's own, or the one after it the user's answers queued.
  const T = schema.tasks
  const t = db
    .select()
    .from(T)
    .where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, item.applicationId)))
    .orderBy(desc(T.createdAt))
    .limit(10)
    .all()
    .find((x) => x.id === item.taskId || x.createdAt >= item.startedAt!)
  if (!t) return { ...base, status: 'failed', summary: 'Its form task is gone.' }
  const s = submissionOf(t)
  return { ...base, taskId: t.id, status: s.status, ...(s.status === 'blocked' ? { blockedBy: blockedByOf(s.summary) } : {}), summary: s.summary, questions: s.questions, evidence: s.evidence ?? null }
}

export interface BatchReport {
  id: string
  mode: BatchMode
  order: BatchOrder
  status: SubmitBatch['status']
  note: string | null
  createdAt: string
  finishedAt: string | null
  /** How many items are in each status. */
  counts: Partial<Record<ItemStatus, number>>
  /** The application whose form is filling or next in line. */
  current: string | null
  items: BatchItemReport[]
}

export const batchReport = (id?: string): BatchReport | null => {
  const b = getBatch(id)
  if (!b) return null
  const items = b.items.map((i, n) => itemReport(i, n + 1))
  const counts: Partial<Record<ItemStatus, number>> = {}
  for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1
  const cur = b.items.find((i) => i.startedAt && !i.done)
  return {
    id: b.id,
    mode: b.mode,
    order: b.order,
    status: b.status,
    note: b.note,
    createdAt: b.createdAt,
    finishedAt: b.finishedAt,
    counts,
    current: cur?.application ?? null,
    items: items.map((i) => ({ ...i, summary: truncate(i.summary, 600) })),
  }
}
