import { z } from 'zod'
import { mcpFor, readyProviders, runJob } from '../ai'
import { logActivity } from '../activity'
import type { schema } from '../db/client'
import { notifyPromise } from '../notify'
import { context, render } from '../prompts'
import { getApplication } from '../services/applications'
import { truncate } from '../text'
import type { TaskOutcome } from './tasks'

/**
 * Research on X through Grok, which can search X natively: hiring posts ("we're hiring", "my team
 * is looking for") in the user's lanes, and the X accounts of people at a target company. Results
 * land in the app through MCP tools like any other agent's work. Runs on Grok Build here, or on
 * Grok Bot when the user sends it there: this is the prompt, and the bookkeeping once it's done.
 */
export const xScoutWork = (task: schema.Task) => {
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  const prompt = render('x-scout', {
    MODE: a ? 'company' : 'leads',
    APP_ID: a?.id ?? '',
    COMPANY: a?.companyName ?? '',
    ROLE: a?.role ?? '',
    CRITERIA: truncate(context.criteria(), 4000),
    INSTRUCTIONS: typeof task.input.instructions === 'string' ? task.input.instructions : '(none)',
  })
  const finish = async (text: string) => {
    logActivity('research', a ? `X research: ${a.companyName}` : 'X scan for hiring posts', { detail: truncate(text, 400), ...(a ? { link: `/applications/${a.id}` } : { link: '/people' }) })
    await notifyPromise({ kind: 'research-ready', title: a ? `X research done: ${a.companyName}` : 'X scan done', body: truncate(text, 400), path: a ? `/applications/${a.id}` : '/', priority: 3, dedupeKey: `x:${task.id}` })
  }
  return { prompt, finish }
}

export const runXScout = async (task: schema.Task): Promise<TaskOutcome> => {
  const ready = await readyProviders()
  const grok = ready.find((p) => p.id === 'grok')
  const w = xScoutWork(task)
  const r = await runJob({ job: 'x', ...(grok ? { provider: 'grok' as const } : {}), prompt: w.prompt, web: true, mcp: mcpFor('app'), maxTurns: 60, timeoutMs: 30 * 60_000 })
  await w.finish(r.text)
  return { output: r.text, sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: r.log, provider: r.provider, model: r.model }
}

export const XScoutInput = z.object({ applicationId: z.string().optional(), instructions: z.string().optional() })
