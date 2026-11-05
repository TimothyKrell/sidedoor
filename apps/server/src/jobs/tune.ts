import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { TUNE_STOPS, TUNE_TARGET, type TuneStop } from '@sidedoor/shared/review'
import { MATCH_NOISE_MARGIN } from '@sidedoor/shared/match'
import { logActivity } from '../activity'
import { mcpFor, runJob } from '../ai'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { matchForAgent, runMatch } from '../match'
import { render } from '../prompts'
import { getApplication, setResumeTune } from '../services/applications'
import { answersFor } from '../services/questions'
import { buildResumePdf, requireResume, saveContent, tailoredFor } from '../services/resumes'
import { getSettings } from '../settings'
import { truncate } from '../text'
import { jdText, type TaskOutcome } from './tasks'

const TuneOut = z.object({
  summary: z.string(),
  rounds: z.number().int().min(0),
  stopped: z.enum(TUNE_STOPS),
})

/**
 * Work the tailored resume up against the posting: edit, re-check, repeat, then ask the user for
 * what only they can add. Sidedoor measures the start and the finish itself, and puts the resume
 * back if the pass left it scoring lower than it found it.
 */
export const runTune = async (task: schema.Task): Promise<TaskOutcome> => {
  const a = task.applicationId ? getApplication(task.applicationId) : undefined
  if (!a) throw new Error('application missing')
  const s = getSettings()
  const resume = tailoredFor(a.id)
  const before = await runMatch(a.id)
  const from = before.match.score
  const finish = (v: { to: number; rounds: number; stopped: TuneStop; summary: string; reverted?: boolean }) => {
    setResumeTune(a.id, { at: nowIso(), from, ...v })
    logActivity('application', `Tuned the resume: ${a.companyName} – ${a.role}`, { detail: `${from} → ${v.to}`, link: `/applications/${a.id}` })
    return `Match ${from} → ${v.to}. ${v.summary}`
  }
  if (from >= TUNE_TARGET) {
    const summary = `It was already at ${from}, past the ${TUNE_TARGET} target, so nothing changed.`
    return { output: finish({ to: from, rounds: 0, stopped: 'target', summary }), costUsd: before.costUsd ?? undefined, log: before.log }
  }

  const start = requireResume(resume.id)
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const r = await runJob({
    job: 'prep',
    prompt: render('tune', {
      APP_ID: a.id,
      LEAD_NAME: `${a.companyName} – ${a.role}`,
      RESUME_ID: resume.id,
      MAX_PAGES: s.prep.maxPages,
      TARGET: TUNE_TARGET,
      NOISE: MATCH_NOISE_MARGIN,
      JD: jdText(a, p),
      MATCH: JSON.stringify(matchForAgent(getApplication(a.id)!)),
      KNOWN_ANSWERS: truncate(answersFor(a.id).map((q) => `- ${q.text} → ${q.answer}`).join('\n'), 8000) || '(none yet)',
    }),
    web: false,
    mcp: mcpFor('app'),
    schema: TuneOut,
    maxTurns: 60,
    timeoutMs: 30 * 60_000,
  })

  const log = [...r.log]
  const cost = (before.costUsd ?? 0) + (r.costUsd ?? 0)
  let after = await runMatch(a.id)
  let reverted = false
  if (after.match.score < from) {
    saveContent(resume.id, start.content, { by: 'agent', reason: 'restore' })
    after = await runMatch(a.id)
    reverted = true
    log.push(`the pass finished lower than it started (${from}); restored the resume`)
  }
  const pdf = await buildResumePdf(resume.id)
  if (pdf.pages > s.prep.maxPages) throw Object.assign(new Error(`resume is ${pdf.pages} pages (max ${s.prep.maxPages}). The AI said: ${truncate(r.data.summary, 400)}`), { log })
  const output = finish({
    to: after.match.score,
    rounds: r.data.rounds,
    stopped: r.data.stopped,
    summary: reverted ? `Its edits scored lower, so the resume is back as it was. ${r.data.summary}` : r.data.summary,
    ...(reverted ? { reverted } : {}),
  })
  return { output, sessionId: r.sessionId, costUsd: cost + (after.costUsd ?? 0) || undefined, log, provider: r.provider, model: r.model }
}
