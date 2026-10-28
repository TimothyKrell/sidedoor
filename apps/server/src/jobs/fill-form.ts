import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { z } from 'zod'
import { mcpFor, runJob } from '../ai'
import { logActivity } from '../activity'
import { openFormTab, withFormLock } from '../browser'
import { paths } from '../config'
import type { schema } from '../db/client'
import { withBrowserTools } from '../mcp/playwright'
import { notifyPromise } from '../notify'
import { context, render } from '../prompts'
import { getApplication, updateApplication } from '../services/applications'
import { buildResumePdf, resumeForApplication } from '../services/resumes'
import { truncate } from '../text'
import type { TaskOutcome } from './tasks'

export const FillReport = z.object({
  outcome: z.enum(['ready', 'needs_you', 'blocked']),
  summary: z.string(),
  filled: z.array(z.object({ field: z.string(), value: z.string() })).default([]),
  needsYou: z.array(z.object({ field: z.string(), why: z.string() })).default([]),
})
export type FillReport = z.infer<typeof FillReport>

/** Open the application form in its own browser window and have the AI fill it, stopping before submit. */
export const runFillForm = (task: schema.Task): Promise<TaskOutcome> =>
  withFormLock(async () => {
    const a = task.applicationId ? getApplication(task.applicationId) : undefined
    if (!a) throw new Error('No application for this task')
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
    let r: Awaited<ReturnType<typeof runJob<typeof FillReport>>>
    try {
      r = await withBrowserTools(tab.cdpEndpoint, workDir, () =>
        runJob({
          job: 'fill',
          prompt: render('fill-form', {
            COMPANY: a.companyName,
            ROLE: a.role,
            URL: url,
            RESUME_PDF: pdf.path,
            PACKAGE: a.packageMd ?? '',
            PROFILE: truncate(context.profile(), 8000),
          }),
          mcp: mcpFor('browser'),
          schema: FillReport,
          maxTurns: 120,
          timeoutMs: 30 * 60_000,
        }),
      )
      report = r.data
    } finally {
      await tab.finish().catch((e: unknown) => console.error('[fill] finish failed', e))
      rmSync(workDir, { recursive: true, force: true })
    }

    const label = `${a.companyName} – ${a.role}`
    const next =
      report.outcome === 'ready'
        ? 'Form filled in the Sidedoor browser window: review it and submit'
        : report.outcome === 'needs_you'
          ? `Form mostly filled; ${report.needsYou.length} item${report.needsYou.length === 1 ? '' : 's'} need you, then submit`
          : `Couldn't fill the form: ${truncate(report.summary, 120)}`
    updateApplication(a.id, { nextAction: next })
    logActivity('application', `Your AI filled the form: ${label}`, { detail: report.summary, link: `/applications/${a.id}` })
    await notifyPromise({
      kind: 'agent',
      title: report.outcome === 'blocked' ? `Couldn't fill ${a.companyName}` : `${a.companyName} form is filled`,
      body: `${report.summary}${report.needsYou.length ? `\nNeeds you: ${report.needsYou.map((n) => n.field).join(', ')}` : ''}`,
      path: `/applications/${a.id}`,
      priority: 4,
    })
    return { output: JSON.stringify(report), sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
  })
