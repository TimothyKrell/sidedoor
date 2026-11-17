import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { blockingFindings, type RuleCheck } from '@sidedoor/shared/rules'
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
import { forWhom, getApplication, setStage, STAGE_LABEL, submitByOf, submitterAllowed, updateApplication } from '../services/applications'
import { docBody } from '../services/documents'
import { askQuestions, isSecurityCode, securityCodeFor, settledFor, spendSecurityCodes } from '../services/questions'
import { checkApplicationRules } from '../services/rules'
import { buildResumePdf, getResume, resumeForApplication } from '../services/resumes'
import { getSettings } from '../settings'
import { clip, truncate } from '../text'
import { experienceContext, experienceLogLine } from '../experience'
import { type AuditEntry, checkFill, FILL_SOURCES, readPackage, submitRefusal } from '../form-answers'
import { announceCode, CODE_WAIT_MS, codeAnnounced, noteResend, resendsLeft } from './code-relay'
import { codeWindowOpen, stoppedForms as stopped } from './form-windows'
import type { TaskOutcome } from './tasks'

export const FillReport = z.object({
  outcome: z.enum(['ready', 'needs_you', 'blocked']),
  summary: z.string(),
  filled: z
    .array(
      z.object({
        field: z.string(),
        value: z.string(),
        source: z.enum(FILL_SOURCES).default('ai_generated'),
        options: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  needsYou: z.array(z.object({ field: z.string(), why: z.string(), options: z.array(z.string()).default([]) })).default([]),
})
export type FillReport = z.infer<typeof FillReport>

export const SubmitReport = z.object({
  outcome: z.enum(['submitted', 'not_submitted', 'blocked']),
  summary: z.string(),
  problems: z.array(z.object({ field: z.string(), why: z.string() })).default([]),
  confirmation: z.string().default(''),
  /** The form asked for a code it emailed or texted before it would take the application. */
  codeRequested: z.boolean().default(false),
})
export type SubmitReport = z.infer<typeof SubmitReport>

/** The step that enters a security code in the window a submit left waiting for one. */
export const CodeReport = z.object({
  outcome: z.enum(['submitted', 'code_rejected', 'not_submitted', 'blocked']),
  summary: z.string(),
  problems: z.array(z.object({ field: z.string(), why: z.string() })).default([]),
  confirmation: z.string().default(''),
  /** After a rejected code: the form was asked for a new one (a "Resend code" link). */
  newCodeSent: z.boolean().default(false),
})

const CODE_FIELD = 'Security code'

const RESEND = 'If it offers a new code ("Resend code", "Send a new code", "Didn\'t get a code?"), click that once and set `newCodeSent`.'
const NO_RESEND = "Don't ask it for a new code: Sidedoor has asked this form for new ones enough times. Leave `newCodeSent` false."

/** The submit stopped at a code the form sent: the report says so, or one of its problems is the code. */
export const stoppedForCode = (s: Pick<SubmitReport, 'outcome' | 'problems'> & { codeRequested?: boolean } | null | undefined) =>
  !!s && s.outcome !== 'submitted' && (!!s.codeRequested || s.problems.some((p) => isSecurityCode(p.field)))

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
  /** Every field the fill put in, where Sidedoor found its value, and whether the user confirmed it. */
  audit?: AuditEntry[]
  /** Filled, then held back from submitting: it fails the user's rules and nobody overrode that. */
  rules?: RuleCheck | null
  /** Stopped at a code the form emailed: when submit was clicked, so the code to use is the newest one sent after this. */
  codeRequestedAt?: string | null
}

/**
 * The filler's report, checked against the package and Standard answers: anything it filled that
 * the user hasn't confirmed comes back as a question, so the fill can't be "ready" with it.
 */
export const reviewFill = (data: FillReport, a: Pick<schema.Application, 'id' | 'packageMd' | 'companyName'>): { report: FillReport; audit: AuditEntry[] } => {
  const { audit, questions } = checkFill({ filled: data.filled, needsYou: data.needsYou, packageMd: a.packageMd, standardAnswers: docBody('answers'), company: a.companyName, settled: settledFor(a.id) })
  if (!questions.length) return { report: data, audit }
  const held = audit.filter((e) => !e.confirmed).length
  const report: FillReport = {
    ...data,
    outcome: data.outcome === 'blocked' ? 'blocked' : 'needs_you',
    summary: `${data.summary} ${held ? `Sidedoor held back ${held} answer${held === 1 ? '' : 's'} you haven't confirmed; ` : ''}${questions.length} question${questions.length === 1 ? '' : 's'} for you.`,
    needsYou: [...data.needsYou, ...questions],
  }
  return { report, audit }
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

/** The open items in the package the user has since answered or dropped, for the filler, which reads the package as text. */
const settledNote = (a: Pick<schema.Application, 'id' | 'packageMd'>) => {
  const settled = settledFor(a.id)
  const items = readPackage(a.packageMd).pending.filter(settled.item)
  return items.length ? `## Settled since the package was written\nThese open items no longer count. Don't hold a field back for them:\n${items.map((i) => `- ${i}`).join('\n')}` : ''
}

const evidenceFrom = (snap: string | null, reported: string): Evidence => ({
  url: snap?.match(/Page URL: (\S+)/)?.[1] ?? null,
  title: snap?.match(/Page Title: (.*)/)?.[1]?.trim() ?? null,
  page: snap ? snapshotText(snap.slice(Math.max(0, snap.search(/```yaml|Snapshot/)))) : '',
  reported,
  at: nowIso(),
})

const isPdf = (path: string) => {
  try {
    return statSync(path).size >= 4 && readFileSync(path).subarray(0, 4).toString() === '%PDF'
  } catch {
    return false
  }
}

/**
 * The PDF of the resume this application sends: its tailored resume when it has one, else the
 * base. Built now when there is none yet, its file is gone, or the resume changed since. Fails
 * with what to do when the tailored resume was deleted or no PDF can be made, rather than
 * opening a form with nothing to upload.
 */
export const resumePdfFor = async (a: Pick<schema.Application, 'resumeId' | 'companyName'>) => {
  if (a.resumeId && !getResume(a.resumeId)) throw new Error(`The tailored resume for ${a.companyName} is gone. Tailor one again (prep) before filling the form.`)
  const resume = resumeForApplication(a)
  if (!resume) throw new Error('No resume to upload. Create one on the Resume page first.')
  const saved = resume.pdfFile ? resolve(paths.files, resume.pdfFile) : null
  const fresh = !!saved && isPdf(saved) && !!resume.pdfAt && resume.pdfAt >= resume.updatedAt
  const path = fresh ? saved : (await buildResumePdf(resume.id)).path
  if (!isPdf(path)) throw new Error(`Couldn't make the PDF of "${resume.title}" (${path} is missing or not a PDF). Open the resume and build its PDF, then try again.`)
  return { path, resume }
}

/** You pressed Approve & submit for this one, or your AI or Grok Bot asked and you still let it submit. */
export const submitAllowed = (task: Pick<schema.Task, 'input'>) => task.input.submit === true && submitterAllowed(submitByOf(task.input))

const SUBMIT_NOTE = `## This one gets submitted
Nobody reviews this form before it goes: when you report "ready", Sidedoor submits it in a
separate step, so:
- Report "ready" only when every required field holds an answer from the material below.
- A required question the material doesn't answer goes under \`needsYou\`: its exact wording in
  \`field\`, and its choices in \`options\` when it has a fixed set. They answer it, and the form is
  filled again.
- An optional question the material doesn't answer: leave it blank and don't list it.
- Sidedoor checks every \`filled\` entry against the package before it submits: anything the
  package marks unconfirmed, or that you made up, stops the submit and is asked instead.`

/**
 * Open the application form in its own browser window and have the AI fill it, stopping before
 * submit. When Grok Bot sent it to be submitted (and the user allows that), a fill with nothing
 * left unanswered is followed by a second, short run that clicks submit and checks it went in.
 * A dry run fills the same way and reports the questions, and never submits.
 */
/** The fill that picks up a window left open: it keeps what's there and reports all of it. */
const RESUMED_NOTE = `## Filled before
Sidedoor filled this form once already and stopped before submitting, for questions. They have
been answered since, in the material below. The window still holds what went in last time, and
some fields may have been changed by hand since. Don't start over:
- Skip the resume upload when the form already shows the file attached.
- Go through every field on the page: fill the empty ones from the material, and fix any that
  doesn't match it now (an answer that came in since takes precedence).
- In \`filled\`, report every field that holds a value, the ones filled before this run too, with
  where its value comes from. A value none of the material gives is "ai_generated": leave it,
  and Sidedoor will ask about it.
- A validation message from the earlier submit attempt can stay on a field after it's fixed, until
  submit is clicked again (a country picker showing "+1" under "Select a country"). A field that
  shows its value is filled: report it in \`filled\`, and don't hold the form back for the message.
- If the window no longer shows this application (another site, an error, or a confirmation that
  it was already sent), change nothing: report "blocked" and say what it shows.`
const resumedNote = (held: string[]) =>
  held.length
    ? `${RESUMED_NOTE}\n\nThese were held back last time and still hold what went in then. Find each one (go back a step\nif the form has steps and lets you), put in the answer the material gives now, and report it in\n\`filled\`:\n${held.map((f) => `- ${f}`).join('\n')}`
    : RESUMED_NOTE

const sameField = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** The fill's report, with what an earlier fill of the same window put in fields it didn't report (steps behind it). */
const withEarlier = (data: FillReport, earlier: FillReport['filled']): FillReport => ({
  ...data,
  filled: [...data.filled, ...earlier.filter((e) => !data.filled.some((f) => sameField(f.field, e.field)))],
})

/** What the window left open after a submit stopped says: why, and what to do. */
const stoppedBanner = (questions: number) =>
  `Sidedoor stopped before submitting: ${questions} question${questions === 1 ? '' : 's'} for you. Answer ${questions === 1 ? 'it' : 'them'} in Sidedoor and it picks up here and submits this, or finish this form yourself.`
const CODE_BANNER = 'Sidedoor is waiting for the security code this form emailed you. Answer "Security code" in Sidedoor and it enters the code here and finishes submitting, or enter it yourself.'

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
    const built = await resumePdfFor(a)
    // The agent may upload only what's in this folder: the resume, under a clean name.
    const workDir = resolve(paths.jobs, `fill-${task.id}`)
    mkdirSync(workDir, { recursive: true, mode: 0o700 })
    const pdf = { path: resolve(workDir, basename(built.path)) }
    copyFileSync(built.path, pdf.path)
    if (!isPdf(pdf.path)) throw new Error(`The resume PDF didn't reach the form's upload folder (${pdf.path}). Nothing was filled.`)
    // And the files attached to the application (a portfolio, a cover letter PDF), under their own names.
    const attached = (a.attachments ?? []).map((x) => {
      const path = resolve(workDir, x.name === basename(pdf.path) ? `${x.label.replace(/\W+/g, '-')}-${x.name}` : x.name)
      copyFileSync(resolve(paths.files, x.file), path)
      return { label: x.label, path }
    })

    // Facts for questions the package doesn't cover: the Experience sections closest to this job and package.
    const posting = a.postingId ? db.select({ jd: schema.postings.jd }).from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
    const experience = experienceContext(`${a.role}\n${posting?.jd ?? ''}\n${a.packageMd}`, 24_000)
    // The window an earlier submit left open: pick up there, guarded again. Gone, or for another
    // URL: start over in a new one.
    const prior = stopped.get(a.id)
    stopped.delete(a.id)
    let resumed = false
    if (prior && prior.url === url) {
      try {
        await prior.tab.guard()
        resumed = true
      } catch (e) {
        console.error(`[fill] the window left open for ${a.companyName} can't be filled again, opening a new one: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (prior && !resumed) await prior.tab.close().catch(() => {})
    // The window stopped at the form's security code and the code is in: enter it there and finish.
    const code = submitting && resumed && prior?.codeAskedAt ? securityCodeFor(a.id) : null
    // Any other submit fills a form that emails a new code if it wants one: one answered before is no use.
    if (submitting && !code) spendSecurityCodes(a.id)
    // The code is kept nowhere but its question, and only until it's used: not in the task's record, its activity or a notice.
    const hide = (t: string) => (code ? t.replaceAll(code.answer, '[security code]') : t)
    let tab = resumed && prior ? prior.tab : await openFormTab(url)
    // Picking up the window left open: what it held then, and the fields that must be looked at again.
    let resuming = resumed && !!prior
    const earlier = prior?.filled ?? []
    const recheck = prior?.held ?? []
    let report: FillReport
    let sent: SubmitReport | null = null
    let evidence: Evidence | null = null
    let held: RuleCheck | null = null
    let meta: { sessionId?: string | null; provider?: string; model?: string } = {}
    // Set when the submit stopped at a code the form sent: when it was asked for.
    let codeAskedAt: string | null = null
    let closed = false
    let message: string | undefined
    const log: string[] = []
    let costUsd = 0
    let audit: AuditEntry[] = []
    try {
      if (code && prior) {
        report = { outcome: 'ready', summary: 'Entered the security code in the window the submit left open.', filled: prior.filled, needsYou: [] }
        audit = prior.audit
        // The rules once more before the click, as the fill does.
        const check = checkApplicationRules(a.id, { questions: prior.filled.map((f) => f.field) })
        if (blockingFindings(check).length) held = check
        else {
          const at = nowIso()
          const go = await withBrowserTools(tab.cdpEndpoint, workDir, async () => {
            await tab.unguard()
            allowSubmit(true)
            db.update(schema.tasks).set({ input: { ...task.input, submitStartedAt: at } }).where(eq(schema.tasks.id, task.id)).run()
            const j = await runJob({ job: 'fill', prompt: render('enter-code', { COMPANY: a.companyName, ROLE: a.role, CODE: code.answer, RESEND: resendsLeft(a.id) > 0 ? RESEND : NO_RESEND }), mcp: mcpFor('browser'), schema: CodeReport, maxTurns: 25, timeoutMs: 8 * 60_000 })
            return { j, snap: await browserSnapshot() }
          })
          // Used, or turned down: either way it's never entered again, so keep no copy.
          spendSecurityCodes(a.id)
          log.push(...(go.j.log ?? []))
          costUsd += go.j.costUsd ?? 0
          meta = go.j
          const c = CodeReport.parse(JSON.parse(hide(JSON.stringify(go.j.data))))
          sent =
            c.outcome === 'code_rejected'
              ? {
                  outcome: 'not_submitted',
                  summary: c.summary,
                  problems: [{ field: code.text, why: c.newCodeSent ? 'The form turned the code down (expired or mistyped) and emailed a new one. Relay the newest code.' : "The form turned the code down (expired or mistyped), and it couldn't be made to send a new one. Request one in the Sidedoor window, then relay it, or finish the form there." }],
                  confirmation: '',
                  codeRequested: true,
                }
              : { outcome: c.outcome, summary: c.summary, problems: c.problems, confirmation: c.confirmation, codeRequested: false }
          if (c.newCodeSent) noteResend(a.id)
          if (c.outcome === 'code_rejected') codeAskedAt = c.newCodeSent ? at : prior.codeAskedAt
          evidence = evidenceFrom(go.snap, c.confirmation)
          if (c.outcome !== 'submitted') db.update(schema.tasks).set({ input: task.input }).where(eq(schema.tasks.id, task.id)).run()
        }
      } else for (;;) {
        // The window left open, filled without reporting a field it held back: it may still hold
        // the old answer, on a step the fill can't see. Start over in a new window instead.
        let again = false as boolean
        const r = await withBrowserTools(tab.cdpEndpoint, workDir, async () => {
          const fill = await runJob({
            job: 'fill',
            prompt: render('fill-form', {
              COMPANY: a.companyName,
              ROLE: a.role,
              URL: url,
              RESUME_PDF: pdf.path,
              ATTACHMENTS: attached.map((x) => `- ${x.label}: ${x.path}`).join('\n'),
              PACKAGE: a.packageMd ?? '',
              SETTLED: settledNote(a),
              PROFILE: clip(context.profile(), 12_000, "get_profile_doc 'answers' with offset"),
              EXPERIENCE: experience.text,
              SUBMIT_NOTE: strict ? SUBMIT_NOTE : '',
              RESUMED: resuming ? resumedNote(recheck) : '',
            }),
            mcp: mcpFor('browser'),
            schema: FillReport,
            maxTurns: 120,
            timeoutMs: 30 * 60_000,
          })
          log.push(...(fill.log ?? []))
          costUsd += fill.costUsd ?? 0
          const unseen = resuming && fill.data.outcome !== 'blocked' ? recheck.filter((h) => ![...fill.data.filled, ...fill.data.needsYou].some((f) => sameField(f.field, h))) : []
          if (unseen.length) {
            again = true
            log.push(`The window left open didn't show ${unseen.join(', ')}, held back last time: filling a new window instead`)
            return fill
          }
          const checked = reviewFill(resuming ? withEarlier(fill.data, earlier) : fill.data, a)
          audit = checked.audit
          const reviewed = { ...fill, data: checked.report }
          // The pre-submit audit: nothing goes in with an answer the user hasn't confirmed.
          if (!submitting || reviewed.data.outcome !== 'ready' || reviewed.data.needsYou.length || submitRefusal(audit)) return reviewed
          // A last look at the user's rules, with the questions the form itself asked.
          const check = checkApplicationRules(a.id, { questions: reviewed.data.filled.map((f) => f.field) })
          if (blockingFindings(check).length) {
            held = check
            return reviewed
          }
          await tab.unguard()
          allowSubmit(true)
          const at = nowIso()
          db.update(schema.tasks).set({ input: { ...task.input, submitStartedAt: at } }).where(eq(schema.tasks.id, task.id)).run()
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
          if (stoppedForCode(go.data)) {
            codeAskedAt = at
            // Asked under one name, so the relay finds it and a new code reopens it.
            if (!go.data.problems.some((p) => isSecurityCode(p.field))) sent = { ...go.data, problems: [...go.data.problems, { field: CODE_FIELD, why: 'The form emailed a code to finish submitting.' }] }
          }
          evidence = evidenceFrom(await browserSnapshot(), go.data.confirmation)
          // It reported back: unless it went in, the same task may try again.
          if (go.data.outcome !== 'submitted') db.update(schema.tasks).set({ input: task.input }).where(eq(schema.tasks.id, task.id)).run()
          return reviewed
        })
        meta = r
        if (!again) {
          report = r.data
          break
        }
        await tab.close().catch(() => {})
        resuming = false
        tab = await openFormTab(url)
      }
      // Submitted: no window left behind. A batch's dry run is a report, with nothing to review: its window closes too.
      const s = sent as SubmitReport | null
      const asks = s ? (s.outcome === 'submitted' ? 0 : s.problems.length) : report.outcome === 'needs_you' ? report.needsYou.length : 0
      const asking = strict && asks > 0
      // A window waiting on a code stays open even for a batch: a new window means a new code.
      if (s?.outcome === 'submitted' || (task.input.closeWhenDone === true && (dryRun || asking) && !codeAskedAt)) {
        await tab.close().catch((e: unknown) => console.error('[fill] close failed', e))
        closed = true
      } else if (asking) {
        // Stopped for questions: the window stays, saying why, until the answers fill it again.
        stopped.set(a.id, { tab, url, filled: report.filled, held: audit.filter((e) => !e.confirmed).map((e) => e.field), audit, codeAskedAt })
        message = codeAskedAt ? CODE_BANNER : stoppedBanner(asks)
      }
    } finally {
      if (!closed) await tab.finish(message).catch((e: unknown) => console.error('[fill] finish failed', e))
      rmSync(workDir, { recursive: true, force: true })
    }

    const label = `${a.companyName} – ${a.role}`
    const out: FillOutput = { ...report, submitting, dryRun, submit: sent, evidence, audit, rules: held, codeRequestedAt: codeAskedAt }
    if (code) log.push('Entered the security code in the form window the last submit left open')
    else {
      log.push(experienceLogLine(experience))
      if (resuming) log.push('Picked up the form window the last submit left open, instead of filling a new one')
    }
    const done = { output: hide(JSON.stringify(out)), sessionId: meta.sessionId, costUsd: costUsd || undefined, log: log.map(hide), provider: meta.provider, model: meta.model }
    const s = sent as SubmitReport | null
    if (s?.outcome === 'submitted') {
      setStage(a.id, 'applied', { note: `Submitted by Sidedoor${forWhom(submitByOf(task.input))}. ${s.summary}` })
      await notifyPromise({ kind: 'agent', title: `Applied: ${a.companyName}`, body: s.summary, path: `/applications/${a.id}`, priority: 3 })
      return done
    }
    const h = held as RuleCheck | null
    if (h) {
      const why = blockingFindings(h).map((f) => f.reason).join('; ')
      updateApplication(a.id, { nextAction: `Not submitted: breaks your rules (${truncate(why, 160)}). Go ahead anyway to submit it.` })
      logActivity('application', `Held back, breaks your rules: ${label}`, { detail: why, link: `/applications/${a.id}` })
      await notifyPromise({ kind: 'agent', title: `Didn't submit ${a.companyName}`, body: `It breaks your rules: ${why}`, path: `/applications/${a.id}`, priority: 4 })
      return done
    }
    const asked = s ? s.problems.map((p) => ({ question: p.field, why: p.why })) : report.needsYou.map((n) => ({ question: n.field, why: n.why, options: n.options, filledValue: audit.find((e) => e.field === n.field && !e.confirmed)?.value ?? null }))
    // Kept as questions: the user answers them in Sidedoor (or through their AI), and the answers stay for next time.
    const raised = asked.length ? askQuestions(a.id, 'fill', asked) : []
    const asks = asked.length
    // A new code prompt: tell Grok Bot once, so it fetches the code instead of checking on a schedule.
    const codeQ = raised.find((q) => isSecurityCode(q.question))
    if (codeAskedAt && codeAskedAt !== prior?.codeAskedAt && codeQ) {
      const told = await announceCode(a, { questionId: codeQ.id, requestedAt: codeAskedAt, pageUrl: (evidence as Evidence | null)?.url ?? null })
      log.push(
        told === 'sent'
          ? 'Told Grok Bot the form is waiting on a security code'
          : told === 'not_configured'
            ? 'No security code webhook set: the question waits in Sidedoor'
            : told === 'failed'
              ? "Couldn't reach the security code webhook: the question waits in Sidedoor"
              : 'Grok Bot was already told about this code',
      )
      done.log = log.map(hide)
    }
    const next = codeAskedAt
      ? codeAskedAt === prior?.codeAskedAt
        ? "The form turned the code down and won't send a new one: finish it in the Sidedoor window"
        : 'Waiting on the security code the form emailed: answer it in Sidedoor and it finishes the submit in the open window'
      : s
      ? `Not submitted: ${truncate(s.summary, 120)}${s.outcome === 'not_submitted' ? ' The form is open in the Sidedoor browser window.' : ''}`
      : report.outcome === 'ready'
        ? dryRun
          ? 'Dry run: the form filled with nothing left to ask. Not submitted; it is open in the Sidedoor browser window'
          : 'Form filled in the Sidedoor browser window: review it and submit'
        : report.outcome === 'needs_you'
          ? strict
            ? `${asks} question${asks === 1 ? '' : 's'} for you before it can go in`
            : `Form mostly filled; ${asks} item${asks === 1 ? '' : 's'} need you, then submit`
          : `Couldn't fill the form: ${truncate(report.summary, 120)}`
    updateApplication(a.id, { nextAction: next })
    logActivity('application', codeAskedAt ? `Waiting on the security code: ${label}` : s ? `Couldn't submit: ${label}` : dryRun ? `Dry run filled the form: ${label}` : `Your AI filled the form: ${label}`, { detail: s?.summary ?? report.summary, link: `/applications/${a.id}` })
    await notifyPromise({
      kind: 'agent',
      title: codeAskedAt ? `${a.companyName} needs the security code it emailed` : s ? `Couldn't submit ${a.companyName}` : report.outcome === 'blocked' ? `Couldn't fill ${a.companyName}` : strict && report.outcome === 'needs_you' ? `${a.companyName} has questions for you` : `${a.companyName} form is filled`,
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
  /**
   * queued/filling: Sidedoor is on it. questions: answer them (answer_questions). code: submit was
   * clicked and the form emailed a security code; relay it (security_codes_waiting). filled: a fill
   * for the user, open in the window for them to check and submit. marked_applied: the user marked
   * it Applied after this stopped, and Sidedoor never saw it go in. The rest are final.
   */
  status: 'queued' | 'filling' | 'submitted' | 'ready' | 'filled' | 'questions' | 'code' | 'blocked' | 'not_submitted' | 'marked_applied' | 'failed' | 'cancelled'
  /** Filled and reported, never submitted. ready means a real run would have submitted it. */
  dryRun: boolean
  summary: string
  questions: { question: string; why: string; options: string[] }[]
  /** For submitted: what the page showed after the click (URL, title, text). */
  evidence?: Evidence | null
  /** Every field the fill put in: its label, value, where the value came from, and whether the user confirmed it. */
  audit: AuditEntry[]
}

const RULES_HELD = (r: RuleCheck) => `Filled, not submitted: it breaks the user's rules (${blockingFindings(r).map((f) => f.reason).join('; ')}). Ask the user; only if they want it anyway, call override_rules, then submit_application again.`

/** Where one fill task stands, for submission_status and a batch's report. */
export const submissionOf = (t: schema.Task): Submission => {
  const a = t.applicationId ? getApplication(t.applicationId) : undefined
  const base = { applicationId: t.applicationId ?? '', application: a ? `${a.companyName} – ${a.role}` : t.title, taskId: t.id, dryRun: t.input.submit === true && t.input.dryRun === true, questions: [], audit: [] as AuditEntry[] }
  if (t.status === 'queued' || t.status === 'running') return { ...base, status: t.status === 'queued' ? 'queued' : 'filling', summary: t.status === 'queued' ? 'Waiting for its turn (one form at a time).' : 'Filling the form now.' }
  if (t.status === 'failed' || t.status === 'cancelled') return { ...base, status: t.status, summary: t.error ?? 'Cancelled.' }
  let o: FillOutput | null = null
  try {
    o = JSON.parse(t.output ?? '') as FillOutput
  } catch {
    o = null
  }
  if (!o) return { ...base, status: 'failed', summary: t.output ?? 'No report.' }
  if (o.audit) base.audit = o.audit
  const asked = o.needsYou.map((n) => ({ question: n.field, why: n.why, options: n.options ?? [] }))
  if (t.input.submit !== true) {
    if (o.outcome === 'blocked') return { ...base, status: 'blocked', summary: o.summary }
    return { ...base, status: 'filled', summary: `${o.summary} Open in the Sidedoor browser window for the user to check and submit.`, questions: asked }
  }
  if (o.submit?.outcome === 'submitted') return { ...base, status: 'submitted', summary: o.submit.summary, evidence: o.evidence ?? null }
  // Marked Applied after this stopped: by hand, since Sidedoor marks it only when it sees it go in.
  if (!o.dryRun && a?.appliedAt && a.appliedAt >= (t.finishedAt ?? t.createdAt))
    return { ...base, status: 'marked_applied', summary: `Marked ${STAGE_LABEL[a.stage]} by hand on ${a.appliedAt.slice(0, 10)} after this submit stopped. Sidedoor never saw it go in. It had stopped here: ${o.submit?.summary ?? o.summary}` }
  if (o.rules) return { ...base, status: 'not_submitted', summary: RULES_HELD(o.rules) }
  if (stoppedForCode(o.submit))
    return { ...base, status: 'code', summary: `${o.submit!.summary} Waiting on the security code it emailed: see security_codes_waiting.`, questions: o.submit!.problems.map((p) => ({ question: p.field, why: p.why, options: [] })) }
  if (o.submit) return { ...base, status: o.submit.outcome === 'blocked' ? 'blocked' : o.submit.problems.length ? 'questions' : 'not_submitted', summary: o.submit.summary, questions: o.submit.problems.map((p) => ({ question: p.field, why: p.why, options: [] })) }
  if (o.outcome === 'needs_you') return { ...base, status: 'questions', summary: o.summary, questions: asked }
  if (o.outcome === 'blocked') return { ...base, status: 'blocked', summary: o.summary }
  // A dry run from before Sidedoor audited fills may have used unconfirmed answers: not ready.
  if (o.dryRun && !o.audit) return { ...base, status: 'not_submitted', summary: `${o.summary} Dry run from before Sidedoor checked answers against the package; do another dry run.` }
  if (o.dryRun) return { ...base, status: 'ready', summary: `${o.summary} Dry run: nothing left to ask; not submitted.` }
  // Filled but not submitted: Grok Bot's permission was turned off before it ran.
  return { ...base, status: 'not_submitted', summary: `${o.summary} Not submitted: letting Grok Bot submit is turned off. The form is open for review.` }
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
    out.push(submissionOf(t))
  }
  return out
}

/** An application whose last submit stopped at a security code the form emailed, and hasn't gone in since. */
export interface CodeWait {
  applicationId: string
  application: string
  stage: schema.ApplicationStage
  /** The question to answer with the code (answer_user_questions). */
  questionId: string | null
  /** needed: relay the code. answered: one is in, and the submit that enters it is queued or running. */
  code: 'needed' | 'answered'
  /** When the form sent the code: relay the newest code that arrived after this, never an older one. */
  codeRequestedAt: string
  /** Sidedoor still holds the window waiting for the code, so the code goes straight in. When false, answering fills the form again in a new window, which sends a new code to relay in turn. */
  windowOpen: boolean
  /** The submit that stopped there. */
  taskId: string
  /** The submit queued or running now, if any. */
  resumingTaskId: string | null
  /** Set when the stage was moved to Applied by hand after the submit stopped: Sidedoor never saw it go in. */
  markedAppliedAt: string | null
  /** Sidedoor POSTed this code prompt to the Grok Bot code webhook. */
  grokBotTold: boolean
  /** The window waits for the code at least until then. */
  waitUntil: string
  /** New codes Sidedoor may still ask the form for if this one is turned down. */
  resendsLeft: number
  next: string
}

/**
 * Applications waiting on a security code: the last submit clicked submit and the form asked for
 * a code it emailed, and none has gone in since. Ones marked Applied by hand are listed too, since
 * Sidedoor never saw those go in.
 */
export const codesWaiting = (): CodeWait[] => {
  const T = schema.tasks
  const Q = schema.questions
  const rows = db.select().from(T).where(eq(T.kind, 'submit-assist')).orderBy(desc(T.createdAt)).limit(500).all().filter((t) => t.input.submit === true && t.input.dryRun !== true && t.applicationId)
  const byApp = new Map<string, schema.Task[]>()
  for (const t of rows) byApp.set(t.applicationId!, [...(byApp.get(t.applicationId!) ?? []), t])
  const out: CodeWait[] = []
  for (const [id, tasks] of byApp) {
    const live = tasks[0]!.status === 'queued' || tasks[0]!.status === 'running' ? tasks[0]! : null
    const last = tasks.find((t) => t.status === 'done')
    if (!last) continue
    let o: FillOutput | null = null
    try {
      o = JSON.parse(last.output ?? '') as FillOutput
    } catch {
      continue
    }
    if (!o || !stoppedForCode(o.submit)) continue
    // Something after it ended differently (failed, cancelled): that's what submission_status reports.
    if (tasks.some((t) => t.createdAt > last.createdAt && t.status !== 'queued' && t.status !== 'running')) continue
    const a = getApplication(id)
    if (!a || a.stage === 'closed') continue
    const q = db.select().from(Q).where(and(eq(Q.applicationId, id), eq(Q.askedBy, 'fill'))).orderBy(desc(Q.updatedAt)).all().find((x) => isSecurityCode(x.text))
    const code: CodeWait['code'] = live && q?.status === 'answered' ? 'answered' : 'needed'
    const windowOpen = codeWindowOpen(id)
    const markedAppliedAt = a.appliedAt && a.appliedAt >= (last.finishedAt ?? last.createdAt) ? a.appliedAt : null
    const at = o.codeRequestedAt ?? last.finishedAt ?? last.createdAt
    const next = markedAppliedAt
      ? `Marked ${STAGE_LABEL[a.stage]} by hand on ${markedAppliedAt.slice(0, 10)}, but Sidedoor never saw it go in. Don't relay a code: ask the user whether it went in (look for the company's confirmation email). If it didn't, they move it back to Approved and send it again.`
      : live
        ? `A submit is ${live.status} for it (${live.id}); check submission_status in a few minutes.`
        : windowOpen
          ? `Relay the newest code emailed after ${at}: answer_user_questions with questionId ${q?.id ?? '(see list_questions)'} and relayedBy. Sidedoor enters it in the open window and submits.`
          : `The window that asked is gone (Sidedoor restarted or it was closed), so that code can't be used. Answering the question anyway starts the submit again in a new window, and the form emails a new code: relay that one when it's listed here.`
    out.push({
      applicationId: id,
      application: `${a.companyName} – ${a.role}`,
      stage: a.stage,
      questionId: q?.id ?? null,
      code,
      codeRequestedAt: at,
      windowOpen,
      taskId: last.id,
      resumingTaskId: live?.id ?? null,
      markedAppliedAt,
      grokBotTold: codeAnnounced(id, at),
      waitUntil: new Date(Date.parse(at) + CODE_WAIT_MS).toISOString(),
      resendsLeft: resendsLeft(id),
      next,
    })
  }
  return out
}

/** Sidedoor's last submit of this application stopped at a security code and never went in: an agent can't call it Applied on its own. */
export const waitingOnCode = (applicationId: string) => codesWaiting().some((w) => w.applicationId === applicationId && !w.markedAppliedAt)
