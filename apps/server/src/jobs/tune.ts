import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { TUNE_AI_STOPS, TUNE_MAX_QUESTIONS, TUNE_TARGET, type TuneStop } from '@sidedoor/shared/review'
import { HEADER_LINE_ID, headerLine, type ResumeContent } from '@sidedoor/shared/resume'
import { MATCH_NOISE_MARGIN, type ResumeMatch } from '@sidedoor/shared/match'
import { logActivity } from '../activity'
import { mcpFor, runJob } from '../ai'
import { db, schema } from '../db/client'
import { nowIso } from '../ids'
import { matchForAgent, runMatch } from '../match'
import { render } from '../prompts'
import { getApplication, setResumeTune } from '../services/applications'
import { answersFor, askedBefore, askQuestions } from '../services/questions'
import { buildResumePdf, requireResume, saveContent, tailoredFor } from '../services/resumes'
import { getSettings } from '../settings'
import { truncate } from '../text'
import { jdText, type TaskOutcome } from './tasks'

const TuneOut = z.object({
  summary: z.string(),
  rounds: z.number().int().min(0),
  stopped: z.enum(TUNE_AI_STOPS),
  questions: z.array(z.object({ question: z.string(), why: z.string(), requirement: z.string() })).optional(),
})

/**
 * Which of the AI's questions to keep: each about a requirement still short after the pass, the
 * ones that could win back the most points first (must-haves before nice-to-haves). The limit is
 * here and not only in the prompt because a prompt's "at most 5" came back as five for nearly
 * every application.
 */
const worthAsking = (asks: NonNullable<z.infer<typeof TuneOut>['questions']>, m: ResumeMatch) => {
  const lost = new Map((m.breakdown ?? []).flatMap((c) => c.gaps.map((g) => [g.id, g.lost] as const)))
  const rank = new Map(
    m.requirements
      .filter((r) => r.level !== 'strong')
      .map((r) => [r.id, (r.kind === 'must' ? 1000 : 0) + (lost.get(r.id) ?? 0)] as const),
  )
  return asks
    .filter((q) => rank.has(q.requirement))
    .sort((x, y) => rank.get(y.requirement)! - rank.get(x.requirement)!)
    .slice(0, TUNE_MAX_QUESTIONS)
}

/**
 * What the user asked of this application, newest first: this task's own instructions and those
 * every prep pass on it was given. A resume shaped by these was shaped on purpose.
 */
export const instructionsFor = (applicationId: string, task?: Pick<schema.Task, 'input'>) => {
  const T = schema.tasks
  const preps = db.select({ input: T.input }).from(T).where(and(eq(T.applicationId, applicationId), eq(T.kind, 'prep'))).orderBy(desc(T.createdAt)).all()
  const said = [task?.input, ...preps.map((p) => p.input)].flatMap((i) => (typeof i?.instructions === 'string' && i.instructions.trim() ? [i.instructions.trim()] : []))
  return [...new Set(said)]
}

/** The most pages a pass may leave: never more than it started with, nor than Settings allow. */
export const pageBudget = (startPages: number, maxPages: number) => Math.min(startPages, maxPages)

/**
 * What a pass may not do, whatever it does for the score: run past its page budget, or add a
 * section or a skills group (a list of tools is a skills section, wherever it sits). The rest of
 * "don't stuff it" is judgment, and it's in the prompt. A pass that breaks one is undone.
 */
export const tuneBreaks = (start: ResumeContent, end: ResumeContent, pages: { start: number; end: number; max: number }) => {
  const why: string[] = []
  const budget = pageBudget(pages.start, pages.max)
  if (pages.end > budget) why.push(`it ran to ${pages.end} pages, past ${budget}`)
  const had = new Set(start.sections.map((x) => x.id))
  const added = end.sections.filter((x) => !had.has(x.id))
  if (added.length) why.push(`it added ${added.map((x) => `a ${x.title || x.type} section`).join(' and ')}`)
  const groups = (c: ResumeContent) => new Set(c.sections.flatMap((x) => (x.type === 'skills' ? x.groups.map((g) => g.id) : [])))
  const before = groups(start)
  if ([...groups(end)].some((g) => !before.has(g))) why.push('it added a skills group')
  return why
}

/**
 * Work the tailored resume up against the posting: edit, re-check, repeat, then leave a few optional
 * questions whose answers could push it further. Answers go to Experience, so every later pass
 * (here and elsewhere) can use them. Sidedoor measures the start and the finish itself, and puts the resume
 * back if the pass left it scoring lower than it found it, or broke a limit (`tuneBreaks`). The pass
 * works within the user's instructions for the application and its notes, and its page budget.
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
  // Answers given since the last pass are new facts: worth a pass, and past the usual target.
  const last = a.tuneJson?.at
  const answered = !!last && answersFor(a.id).some((q) => (q.answeredAt ?? '') > last)
  const target = answered ? 100 : TUNE_TARGET
  if (from >= target) {
    const summary = `It was already at ${from}, past the ${TUNE_TARGET} target, so nothing changed.`
    return { output: finish({ to: from, rounds: 0, stopped: 'target', summary }), costUsd: before.costUsd ?? undefined, log: before.log }
  }

  const start = requireResume(resume.id)
  const startPages = (await buildResumePdf(resume.id)).pages
  const budget = pageBudget(startPages, s.prep.maxPages)
  const told = instructionsFor(a.id, task)
  const header = headerLine(start.content)
  const p = a.postingId ? db.select().from(schema.postings).where(eq(schema.postings.id, a.postingId)).get() : undefined
  const r = await runJob({
    job: 'prep',
    prompt: render('tune', {
      APP_ID: a.id,
      LEAD_NAME: `${a.companyName} – ${a.role}`,
      RESUME_ID: resume.id,
      MAX_PAGES: budget,
      START_PAGES: startPages,
      INSTRUCTIONS: truncate(told.join('\n\n---\n\n'), 12000) || '(none)',
      APP_NOTES: truncate(a.notesMd?.trim() ?? '', 12000) || '(none)',
      HEADER: header ? `[${HEADER_LINE_ID}] ${header.text}` : '(no location or links in the header)',
      TARGET: target,
      NOISE: MATCH_NOISE_MARGIN,
      JD: jdText(a, p, 'resume tuning'),
      MATCH: JSON.stringify(matchForAgent(getApplication(a.id)!)),
      KNOWN_ANSWERS: truncate(answersFor(a.id).map((q) => `- ${q.text} → ${q.answer}`).join('\n'), 8000) || '(none yet)',
      ASKED_BEFORE: truncate(askedBefore(), 16000) || '(nothing yet)',
      MAX_QUESTIONS: TUNE_MAX_QUESTIONS,
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
  let pdf = await buildResumePdf(resume.id)
  // Undo the whole pass if it scored lower or broke a limit: a higher score isn't worth a longer
  // resume or a tool list the user didn't want.
  const breaks = tuneBreaks(start.content, requireResume(resume.id).content, { start: startPages, end: pdf.pages, max: s.prep.maxPages })
  const why = after.match.score < from ? [`it scored lower (${after.match.score}, from ${from})`, ...breaks] : breaks
  if (why.length) {
    saveContent(resume.id, start.content, { by: 'agent', reason: 'restore' })
    after = await runMatch(a.id)
    pdf = await buildResumePdf(resume.id)
    log.push(`restored the resume: ${why.join('; ')}`)
  }
  const reverted = why.length > 0
  if (pdf.pages > s.prep.maxPages) throw Object.assign(new Error(`resume is ${pdf.pages} pages (max ${s.prep.maxPages}). The AI said: ${truncate(r.data.summary, 400)}`), { log })
  const asks = worthAsking(r.data.questions ?? [], after.match)
  if (asks.length) askQuestions(a.id, 'tune', asks.map((q) => ({ question: q.question, why: q.why, about: 'you' as const, saveTo: 'experience' as const })))
  const output = finish({
    to: after.match.score,
    rounds: r.data.rounds,
    stopped: r.data.stopped,
    summary: reverted ? `The resume is back as it was, because ${why.join(' and ')}. ${r.data.summary}` : r.data.summary,
    ...(reverted ? { reverted } : {}),
  })
  return { output, sessionId: r.sessionId, costUsd: cost + (after.costUsd ?? 0) || undefined, log, provider: r.provider, model: r.model }
}
