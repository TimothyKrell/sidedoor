import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { mcpFor, runJob } from '../ai'
import { logActivity } from '../activity'
import { openFormTab, withFormLock } from '../browser'
import { paths } from '../config'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { withBrowserTools } from '../mcp/playwright'
import { allowSubmit, browserSnapshot } from '../mcp/server'
import { notifyPromise } from '../notify'
import { context, render } from '../prompts'
import { grokBotToken } from '../secrets'
import { getApplication, setStage, updateApplication } from '../services/applications'
import { buildResumePdf, resumeForApplication } from '../services/resumes'
import { getSettings } from '../settings'
import { truncate } from '../text'
import type { TaskOutcome } from './tasks'

export const FillReport = z.object({
  outcome: z.enum(['ready', 'needs_you', 'blocked']),
  summary: z.string(),
  filled: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  needsYou: z.array(z.object({ field: z.string(), why: z.string(), options: z.array(z.string()).default([]) })).default([]),
})
export type FillReport = z.infer<typeof FillReport>

export const SubmitReport = z.object({
  outcome: z.enum(['submitted', 'not_submitted', 'blocked']),
  summary: z.string(),
  problems: z.array(z.object({ field: z.string(), why: z.string() })).default([]),
  confirmation: z.string().default(''),
})
export type SubmitReport = z.infer<typeof SubmitReport>

/** What the page showed after the submit click, read by Sidedoor from the window itself. */
export interface Evidence {
  url: string | null
  title: string | null
  /** The page's visible text, shortened. */
  page: string
  /** The confirmation the submit step says it saw, word for word. */
  reported: string
  at: string
}

/** What a fill task stores as its output: the fill, and the submit step when Grok Bot asked for one. */
export interface FillOutput extends FillReport {
  submitting?: boolean
  dryRun?: boolean
  submit?: SubmitReport | null
  evidence?: Evidence | null
}

/** The visible text of a Playwright snapshot (its quoted names and text nodes), without the tree markup. */
export const snapshotText = (snap: string) => {
  const words: string[] = []
  for (const m of snap.matchAll(/"((?:[^"\\]|\\.)+)"|\btext: (.+)$/gm)) {
    const w = (m[1] ?? m[2] ?? '').trim()
    if (w && words.at(-1) !== w) words.push(w)
  }
  return truncate(words.join(' · ') || snap, 2000)
}

const evidenceFrom = (snap: string | null, reported: string): Evidence => ({
  url: snap?.match(/Page URL: (\S+)/)?.[1] ?? null,
  title: snap?.match(/Page Title: (.*)/)?.[1]?.trim() ?? null,
  page: snap ? snapshotText(snap.slice(Math.max(0, snap.search(/```yaml|Snapshot/)))) : '',
  reported,
  at: nowIso(),
})

/** Grok Bot asked for this one to go in, and the user still lets it submit. */
export const submitAllowed = (task: Pick<schema.Task, 'input'>) => task.input.submit === true && getSettings().grokBot.submit && !!grokBotToken()

const SUBMIT_NOTE = `## This one gets submitted
Nobody reviews this form before it goes: when you report "ready", Sidedoor submits it in a
separate step, so:
- Report "ready" only when every required field holds an answer from the material below.
- A required question the material doesn't answer goes under \`needsYou\`: its exact wording in
  \`field\`, and its choices in \`options\` when it has a fixed set. They answer it, and the form is
  filled again.
- An optional question the material doesn't answer: leave it blank and don't list it.`

/**
 * Open the application form in its own browser window and have the AI fill it, stopping before
 * submit. When Grok Bot sent it to be submitted (and the user allows that), a fill with nothing
 * left unanswered is followed by a second, short run that clicks submit and checks it went in.
 * A dry run fills the same way and reports the questions, and never submits.
 */
export const runFillForm = (task: schema.Task): Promise<TaskOutcome> =>
  withFormLock(async () => {
    const a = task.applicationId ? getApplication(task.applicationId) : undefined
    if (!a) throw new Error('No application for this task')
    const dryRun = task.input.submit === true && task.input.dryRun === true
    const submitting = submitAllowed(task) && !dryRun
    // Filled to the submit bar: every required question answered, or listed for the user.
    const strict = submitting || dryRun
    if (submitting && a.appliedAt) throw new Error(`Already applied on ${a.appliedAt.slice(0, 10)}; not submitting again.`)
    // A submit step that started and never reported back may have gone in: never click it twice.
    if (submitting && task.input.submitStartedAt) throw new Error(`The submit step started at ${String(task.input.submitStartedAt)} and never reported back. Check the company's confirmation email or the form before trying again.`)
    const url = a.applyUrl ?? a.jobUrl
    if (!url) throw new Error('This application has no apply URL. Add one on the Details tab.')
    if (url.startsWith('mailto:')) throw new Error(`This job takes applications by email (${url.slice(7).split('?')[0]}), not a form. Draft the email instead.`)
    if (!a.packageMd) throw new Error('No application package yet. Run "Prepare application" first.')
    const resume = resumeForApplication(a)
    if (!resume) throw new Error('No resume to upload. Create one on the Resume page first.')
    const built = resume.pdfFile ? { path: resolve(paths.files, resume.pdfFile) } : await buildResumePdf(resume.id)
    // The agent may upload only what's in this folder: the resume, under a clean name.
    const workDir = resolve(paths.jobs, `fill-${task.id}`)
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    const pdf = { path: resolve(workDir, basename(built.path)) }
    copyFileSync(built.path, pdf.path)

    const tab = await openFormTab(url)
    let report: FillReport
    let sent: SubmitReport | null = null
    let evidence: Evidence | null = null
    let r: Awaited<ReturnType<typeof runJob<typeof FillReport>>>
    let closed = false
    const log: string[] = []
    let costUsd = 0
    try {
      r = await withBrowserTools(tab.cdpEndpoint, workDir, async () => {
        const fill = await runJob({
          job: 'fill',
          prompt: render('fill-form', {
            COMPANY: a.companyName,
            ROLE: a.role,
            URL: url,
            RESUME_PDF: pdf.path,
            PACKAGE: a.packageMd ?? '',
            PROFILE: truncate(context.profile(), 8000),
            SUBMIT_NOTE: strict ? SUBMIT_NOTE : '',
          }),
          mcp: mcpFor('browser'),
          schema: FillReport,
          maxTurns: 120,
          timeoutMs: 30 * 60_000,
        })
        log.push(...(fill.log ?? []))
        costUsd += fill.costUsd ?? 0
        if (!submitting || fill.data.outcome !== 'ready' || fill.data.needsYou.length) return fill
        await tab.unguard()
        allowSubmit(true)
        db.update(schema.tasks).set({ input: { ...task.input, submitStartedAt: nowIso() } }).where(eq(schema.tasks.id, task.id)).run()
        const go = await runJob({
          job: 'fill',
          prompt: render('submit-form', { COMPANY: a.companyName, ROLE: a.role }),
          mcp: mcpFor('browser'),
          schema: SubmitReport,
          maxTurns: 25,
          timeoutMs: 8 * 60_000,
        })
        log.push(...(go.log ?? []))
        costUsd += go.costUsd ?? 0
        sent = go.data
        evidence = evidenceFrom(await browserSnapshot(), go.data.confirmation)
        // It reported back: unless it went in, the same task may try again.
        if (go.data.outcome !== 'submitted') db.update(schema.tasks).set({ input: task.input }).where(eq(schema.tasks.id, task.id)).run()
        return fill
      })
      report = r.data
      // Submitted, or to be filled again once they answer: no window left behind for either.
      const s = sent as SubmitReport | null
      if (s?.outcome === 'submitted' || (strict && !s && report.outcome === 'needs_you')) {
        await tab.close().catch((e: unknown) => console.error('[fill] close failed', e))
        closed = true
      }
    } finally {
      if (!closed) await tab.finish().catch((e: unknown) => console.error('[fill] finish failed', e))
      rmSync(workDir, { recursive: true, force: true })
    }

    const label = `${a.companyName} – ${a.role}`
    const out: FillOutput = { ...report, submitting, dryRun, submit: sent, evidence }
    const done = { output: JSON.stringify(out), sessionId: r.sessionId, costUsd: costUsd || undefined, log, provider: r.provider, model: r.model }
    const s = sent as SubmitReport | null
    if (s?.outcome === 'submitted') {
      setStage(a.id, 'applied', { note: `Submitted by Sidedoor for Grok Bot. ${s.summary}` })
      await notifyPromise({ kind: 'agent', title: `Applied: ${a.companyName}`, body: s.summary, path: `/applications/${a.id}`, priority: 3 })
      return done
    }
    const asks = s ? s.problems.length : report.needsYou.length
    const next = s
      ? `Not submitted: ${truncate(s.summary, 120)}${s.outcome === 'not_submitted' ? ' The form is open in the Sidedoor browser window.' : ''}`
      : report.outcome === 'ready'
        ? dryRun
          ? 'Dry run: the form filled with nothing left to ask. Not submitted; it is open in the Sidedoor browser window'
          : 'Form filled in the Sidedoor browser window: review it and submit'
        : report.outcome === 'needs_you'
          ? strict
            ? `${asks} question${asks === 1 ? '' : 's'} for you before Grok Bot can submit`
            : `Form mostly filled; ${asks} item${asks === 1 ? '' : 's'} need you, then submit`
          : `Couldn't fill the form: ${truncate(report.summary, 120)}`
    updateApplication(a.id, { nextAction: next })
    logActivity('application', s ? `Couldn't submit: ${label}` : dryRun ? `Dry run filled the form: ${label}` : `Your AI filled the form: ${label}`, { detail: s?.summary ?? report.summary, link: `/applications/${a.id}` })
    await notifyPromise({
      kind: 'agent',
      title: s ? `Couldn't submit ${a.companyName}` : report.outcome === 'blocked' ? `Couldn't fill ${a.companyName}` : strict && report.outcome === 'needs_you' ? `${a.companyName} has questions for you` : `${a.companyName} form is filled`,
      body: `${s?.summary ?? report.summary}${report.needsYou.length ? `\nNeeds you: ${report.needsYou.map((n) => n.field).join(', ')}` : ''}`,
      path: `/applications/${a.id}`,
      priority: 4,
    })
    return done
  })

export interface Submission {
  applicationId: string
  application: string
  taskId: string
  /** queued/filling: Sidedoor is on it. questions: answer them (answer_questions). The rest are final. */
  status: 'queued' | 'filling' | 'submitted' | 'ready' | 'questions' | 'blocked' | 'not_submitted' | 'failed' | 'cancelled'
  /** Filled and reported, never submitted. ready means a real run would have submitted it. */
  dryRun: boolean
  summary: string
  questions: { question: string; why: string; options: string[] }[]
  /** For submitted: what the page showed after the click (URL, title, text). */
  evidence?: Evidence | null
}

/** Where each application Grok Bot sent to be submitted stands: its latest submit task. */
export const submissions = (applicationId?: string): Submission[] => {
  const T = schema.tasks
  const rows = db
    .select()
    .from(T)
    .where(and(eq(T.kind, 'submit-assist'), ...(applicationId ? [eq(T.applicationId, applicationId)] : [])))
    .orderBy(desc(T.createdAt))
    .limit(applicationId ? 20 : 300)
    .all()
    .filter((t) => t.input.submit === true && t.applicationId)
  const seen = new Set<string>()
  const out: Submission[] = []
  for (const t of rows) {
    if (seen.has(t.applicationId!)) continue
    seen.add(t.applicationId!)
    const a = getApplication(t.applicationId!)
    const base = { applicationId: t.applicationId!, application: a ? `${a.companyName} – ${a.role}` : t.title, taskId: t.id, dryRun: t.input.dryRun === true, questions: [] }
    if (t.status === 'queued' || t.status === 'running') out.push({ ...base, status: t.status === 'queued' ? 'queued' : 'filling', summary: t.status === 'queued' ? 'Waiting for its turn (one form at a time).' : 'Filling the form now.' })
    else if (t.status === 'failed' || t.status === 'cancelled') out.push({ ...base, status: t.status, summary: t.error ?? 'Cancelled.' })
    else {
      let o: FillOutput | null = null
      try {
        o = JSON.parse(t.output ?? '') as FillOutput
      } catch {
        o = null
      }
      if (!o) out.push({ ...base, status: 'failed', summary: t.output ?? 'No report.' })
      else if (o.submit?.outcome === 'submitted') out.push({ ...base, status: 'submitted', summary: o.submit.summary, evidence: o.evidence ?? null })
      else if (o.submit) out.push({ ...base, status: o.submit.outcome === 'blocked' ? 'blocked' : o.submit.problems.length ? 'questions' : 'not_submitted', summary: o.submit.summary, questions: o.submit.problems.map((p) => ({ question: p.field, why: p.why, options: [] })) })
      else if (o.outcome === 'needs_you') out.push({ ...base, status: 'questions', summary: o.summary, questions: o.needsYou.map((n) => ({ question: n.field, why: n.why, options: n.options ?? [] })) })
      else if (o.outcome === 'blocked') out.push({ ...base, status: 'blocked', summary: o.summary })
      else if (o.dryRun) out.push({ ...base, status: 'ready', summary: `${o.summary} Dry run: nothing left to ask; not submitted.` })
      // Filled but not submitted: Grok Bot's permission was turned off before it ran.
      else out.push({ ...base, status: 'not_submitted', summary: `${o.summary} Not submitted: letting Grok Bot submit is turned off. The form is open for review.` })
    }
  }
  return out
}
