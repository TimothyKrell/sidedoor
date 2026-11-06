import { z } from 'zod'
import { mcpFor, runJob } from '../ai'
import { schema } from '../db/client'
import { render } from '../prompts'
import { postingForApplication } from '../queries'
import { getApplication, setBrief } from '../services/applications'
import { jdText, type TaskOutcome } from './tasks'

const BriefOut = z.object({ summary: z.string(), highlights: z.array(z.string()).default([]) })

/** What the job is, for the top of its review card. Only reads the listing: the lookup tools change nothing. */
export const runBrief = async (task: schema.Task): Promise<TaskOutcome> => {
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  if (!a) throw new Error('application missing')
  const r = await runJob({
    job: 'triage',
    prompt: render('brief', { LEAD_NAME: `${a.companyName} – ${a.role}`, JOB_URL: a.jobUrl ?? a.applyUrl ?? '(none)', JD: jdText(a, postingForApplication(a), 'the job summary') }),
    mcp: mcpFor('lookup'),
    schema: BriefOut,
    maxTurns: 6,
    timeoutMs: 5 * 60_000,
  })
  const done = { sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
  const summary = r.data.summary.trim()
  if (!summary) return { output: 'Couldn’t read a description of this job.', ...done }
  setBrief(a.id, { summary, highlights: r.data.highlights.map((h) => h.trim()).filter(Boolean).slice(0, 4) })
  return { output: summary, ...done }
}
