import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { type MatchRequirement, matchScore, type ResumeMatch } from '@sidedoor/shared/match'
import { mcpFor, runJob } from './ai'
import { context, render } from './prompts'
import { db, schema } from './db/client'
import { nowIso } from './ids'
import { linesOf, resumeForApplication } from './services/resumes'
import { getApplication, setResumeMatch } from './services/applications'
import { truncate } from './text'

const MatchOut = z.object({
  summary: z.string(),
  requirements: z.array(
    z.object({
      id: z.string().nullish(),
      kind: z.enum(['must', 'nice']),
      short: z.string(),
      quote: z.string(),
      level: z.enum(['strong', 'partial', 'weak', 'missing']),
      evidence: z.array(z.object({ line_id: z.string(), short: z.string() })).default([]),
      note: z.string(),
      fix: z.string().nullish(),
    }),
  ),
})

/** Models sometimes write the word instead of null. */
const noFix = (f: string | null | undefined) => !f?.trim() || /^(none|null|n\/a|-)\.?$/i.test(f.trim())

/**
 * Turn Claude's answer into the stored match: keep only evidence lines that exist, attach their
 * text, keep ids from the last check and number new items after them, and score it in code.
 */
export const buildMatch = (
  out: z.infer<typeof MatchOut>,
  lines: { id: string; text: string }[],
  previous: MatchRequirement[],
  meta: Pick<ResumeMatch, 'at' | 'model' | 'doc' | 'resumeVersion'>,
): ResumeMatch => {
  const text = new Map(lines.map((l) => [l.id, l.text]))
  const known = new Set(previous.map((r) => r.id))
  const used = new Set<string>()
  let next = previous.reduce((n, r) => Math.max(n, Number(r.id.replace(/\D/g, '')) || 0), 0)
  const requirements = out.requirements.map((r): MatchRequirement => {
    let id = r.id && known.has(r.id) && !used.has(r.id) ? r.id : null
    id ??= `r${++next}`
    used.add(id)
    const evidence = r.evidence.flatMap((e) => {
      const t = text.get(e.line_id)
      return t ? [{ lineId: e.line_id, short: e.short, text: t }] : []
    })
    // Evidence Claude cited on a line that doesn't exist doesn't count.
    const level = r.level !== 'missing' && !evidence.length ? 'missing' : r.level
    return { id, kind: r.kind, short: r.short, quote: r.quote, level, evidence: evidence.slice(0, 3), note: r.note, fix: noFix(r.fix) ? null : r.fix!.trim() }
  })
  return { ...meta, score: matchScore(requirements), summary: out.summary, requirements }
}

/** Check the application's resume against its posting and store the result on the application. */
export const runMatch = async (applicationId: string) => {
  const a = getApplication(applicationId)
  if (!a) throw new Error('application missing')
  const P = schema.postings
  const p = a.postingId
    ? db.select().from(P).where(eq(P.id, a.postingId)).get()
    : a.jobUrl
      ? db.select().from(P).where(or(eq(P.url, a.jobUrl), eq(P.applyUrl, a.jobUrl), eq(P.viaUrl, a.jobUrl))).orderBy(desc(P.firstSeenAt)).get()
      : undefined
  const resume = resumeForApplication(a)
  if (!resume) throw new Error('No resume to check')
  const doc = resume.id
  const version = String(resume.version)
  const lines = linesOf(resume).filter((l) => l.kind !== 'heading')
  const jd = p?.jd || null
  const url = a.jobUrl ?? a.applyUrl
  if (!jd && !url) throw new Error('No job description or listing URL to check against')
  const previous = a.matchJson?.requirements ?? []
  const prompt = render('match', {
    ROLE: a.role,
    COMPANY: a.companyName,
    JD: jd ? truncate(jd, 16_000) : `(not captured: read ${url} with mcp__sidedoor__read_page, which renders JavaScript pages, and use the posting there)`,
    RESUME: lines.map((l) => `[${l.id}] ${l.text}`).join('\n'),
    INVENTORY: truncate(context.inventory(), 30_000),
    PREVIOUS: previous.length ? JSON.stringify(previous.map((r) => ({ id: r.id, kind: r.kind, short: r.short, quote: r.quote }))) : '(none: first check)',
  })
  const r = await runJob({ job: 'match', prompt, schema: MatchOut, timeoutMs: 10 * 60_000, ...(jd ? { maxTurns: 3 } : { mcp: mcpFor('lookup'), maxTurns: 10 }) })
  const match = buildMatch(r.data, lines, previous, { at: nowIso(), model: `${r.provider}${r.model ? `/${r.model}` : ''}`, doc, resumeVersion: version })
  setResumeMatch(a.id, match)
  return { match, costUsd: r.costUsd, sessionId: r.sessionId, log: r.log }
}

/** The stored match as agents read it: per-requirement verdicts, and whether the resume changed since. */
export const matchForAgent = (a: Pick<schema.Application, 'resumeId' | 'matchJson'>) => {
  const m = a.matchJson
  if (!m) return null
  const r = resumeForApplication(a)
  return {
    score: m.score,
    checkedAt: m.at,
    doc: m.doc,
    resumeChangedSince: !r || r.id !== m.doc || String(r.version) !== m.resumeVersion,
    summary: m.summary,
    requirements: m.requirements.map((r) => ({
      id: r.id,
      kind: r.kind,
      short: r.short,
      quote: r.quote,
      level: r.level,
      lines: r.evidence.map((e) => e.lineId),
      note: r.note,
      fix: r.fix,
    })),
  }
}
