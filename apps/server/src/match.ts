import { createHash } from 'node:crypto'
import { desc, eq, or } from 'drizzle-orm'
import { z } from 'zod'
import { MATCH_AREAS, MATCH_NOISE_MARGIN, MATCH_RUBRIC_VERSION, type MatchRequirement, type ResumeMatch, scoreMatch } from '@sidedoor/shared/match'
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
      area: z.enum(MATCH_AREAS).catch('skills'),
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

const hash = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16)
type Line = { id: string; text: string }

/** What a check reads, fingerprinted: same rubric, posting and resume lines → the same result. */
export const matchInputs = (jdKey: string, lines: Line[]) => {
  const jdHash = hash(`${MATCH_RUBRIC_VERSION}\n${jdKey}`)
  return { jdHash, inputHash: hash(`${jdHash}\n${lines.map((l) => `${l.id}\t${l.text}`).join('\n')}`), lineHashes: Object.fromEntries(lines.map((l) => [l.id, hash(l.text)])) }
}

/** The previous check counts as this one's baseline only under the same rubric and posting. */
const frozenBy = (prev: ResumeMatch | null | undefined, jdHash: string) => (prev?.rubricVersion === MATCH_RUBRIC_VERSION && prev.jdHash === jdHash && prev.lineHashes ? prev : null)

/**
 * Turn Claude's answer into the stored match: keep only evidence lines that exist, attach their
 * text, keep ids from the last check and number new items after them, and score it in code.
 *
 * Against a baseline (the last check, same rubric and posting) the requirement list is frozen:
 * its items, in its order, with their kind, area and wording; new items are dropped. And an item
 * keeps its last verdict unless a line it cited changed or went away, or it now cites a changed
 * line. So editing one bullet can only move the requirements that bullet touches.
 */
export const buildMatch = (
  out: z.infer<typeof MatchOut>,
  lines: Line[],
  prev: ResumeMatch | null | undefined,
  meta: Pick<ResumeMatch, 'at' | 'model' | 'doc' | 'resumeVersion'> & { jdKey: string },
): ResumeMatch => {
  const { jdKey, ...stamp } = meta
  const inputs = matchInputs(jdKey, lines)
  const text = new Map(lines.map((l) => [l.id, l.text]))
  const previous = prev?.requirements ?? []
  const base = frozenBy(prev, inputs.jdHash)
  const changed = (lineId: string) => !base || base.lineHashes![lineId] !== inputs.lineHashes[lineId]
  const known = new Map(previous.map((r) => [r.id, r]))
  const used = new Set<string>()
  let next = previous.reduce((n, r) => Math.max(n, Number(r.id.replace(/\D/g, '')) || 0), 0)
  const evidenceOf = (ev: { lineId: string; short: string }[]) =>
    ev.flatMap((e) => {
      const t = text.get(e.lineId)
      return t ? [{ lineId: e.lineId, short: e.short, text: t }] : []
    })
  // Evidence Claude cited on a line that doesn't exist doesn't count.
  const settle = (r: MatchRequirement): MatchRequirement => {
    const evidence = evidenceOf(r.evidence).slice(0, 3)
    return { ...r, evidence, level: r.level !== 'missing' && !evidence.length ? 'missing' : r.level }
  }
  const judged = out.requirements.map((r): MatchRequirement => {
    let id = r.id && known.has(r.id) && !used.has(r.id) ? r.id : null
    id ??= `r${++next}`
    used.add(id)
    const was = known.get(id)
    // Known items keep their wording; the model only re-judges them.
    const fixed = was ? { kind: was.kind, short: was.short, quote: was.quote, area: base ? (was.area ?? r.area) : r.area } : { kind: r.kind, short: r.short, quote: r.quote, area: r.area }
    return settle({ id, ...fixed, level: r.level, evidence: r.evidence.map((e) => ({ lineId: e.line_id, short: e.short, text: '' })), note: r.note, fix: noFix(r.fix) ? null : r.fix!.trim() })
  })
  let requirements = judged
  if (base) {
    const byId = new Map(judged.map((r) => [r.id, r]))
    requirements = base.requirements.map((was) => {
      const now = byId.get(was.id)
      const touched = was.evidence.some((e) => changed(e.lineId)) || !!now?.evidence.some((e) => changed(e.lineId))
      if (now && touched) return now
      // Untouched: the verdict stands (the fix may name a newer Experience fact).
      return settle({ ...was, fix: now ? now.fix : was.fix })
    })
  }
  const { score, breakdown } = scoreMatch(requirements)
  return { ...stamp, score, summary: out.summary, requirements, rubricVersion: MATCH_RUBRIC_VERSION, breakdown, ...inputs, previousScore: prev?.score ?? null }
}

/** The posting a match check reads for an application. */
const postingOf = (a: schema.Application) => {
  const P = schema.postings
  return a.postingId
    ? db.select().from(P).where(eq(P.id, a.postingId)).get()
    : a.jobUrl
      ? db.select().from(P).where(or(eq(P.url, a.jobUrl), eq(P.applyUrl, a.jobUrl), eq(P.viaUrl, a.jobUrl))).orderBy(desc(P.firstSeenAt)).get()
      : undefined
}

/**
 * Check the application's resume against its posting and store the result on the application.
 * When nothing it reads has changed since the last check, that check stands (no AI call), so the
 * same resume and posting always give the same stored score.
 */
export const runMatch = async (applicationId: string) => {
  const a = getApplication(applicationId)
  if (!a) throw new Error('application missing')
  const p = postingOf(a)
  const resume = resumeForApplication(a)
  if (!resume) throw new Error('No resume to check')
  const doc = resume.id
  const version = String(resume.version)
  const lines = linesOf(resume).filter((l) => l.kind !== 'heading')
  const jd = p?.jd || null
  const url = a.jobUrl ?? a.applyUrl
  if (!jd && !url) throw new Error('No job description or listing URL to check against')
  const jdKey = jd ?? `url:${url}`
  const prev = a.matchJson
  const inputs = matchInputs(jdKey, lines)
  if (prev?.inputHash === inputs.inputHash) {
    const match = { ...prev, doc, resumeVersion: version, previousScore: prev.score }
    setResumeMatch(a.id, match)
    return { match, reused: true, costUsd: 0, sessionId: undefined, log: ['Resume and posting unchanged since the last check: kept its result.'] }
  }
  const previous = prev?.requirements ?? []
  const base = frozenBy(prev, inputs.jdHash)
  const changedLines = base ? lines.filter((l) => base.lineHashes![l.id] !== inputs.lineHashes[l.id]).map((l) => l.id) : []
  const prompt = render('match', {
    ROLE: a.role,
    COMPANY: a.companyName,
    JD: jd ? truncate(jd, 16_000) : `(not captured: read ${url} with mcp__sidedoor__read_page, which renders JavaScript pages, and use the posting there)`,
    RESUME: lines.map((l) => `[${l.id}] ${l.text}`).join('\n'),
    INVENTORY: truncate(context.inventory(), 30_000),
    PREVIOUS: previous.length ? JSON.stringify(previous.map((r) => ({ id: r.id, kind: r.kind, area: r.area ?? null, short: r.short, quote: r.quote }))) : '(none: first check)',
    CHANGED: !base ? '(not tracked: judge every requirement)' : changedLines.length ? changedLines.join(', ') : '(none)',
  })
  const r = await runJob({ job: 'match', prompt, schema: MatchOut, timeoutMs: 10 * 60_000, ...(jd ? { maxTurns: 3 } : { mcp: mcpFor('lookup'), maxTurns: 10 }) })
  const match = buildMatch(r.data, lines, prev, { at: nowIso(), model: `${r.provider}${r.model ? `/${r.model}` : ''}`, doc, resumeVersion: version, jdKey })
  setResumeMatch(a.id, match)
  return { match, reused: false, costUsd: r.costUsd, sessionId: r.sessionId, log: r.log }
}

/** "match 64 -> 81" in a pass's summary, with the score after the arrow. */
const MATCH_LINE = /\b(match(?: score)?:?\s*)(\d{1,3}|n\/a|none|-|–)(\s*(?:->|→|to)\s*)(\d{1,3})(\s*\/\s*100)?/gi

/**
 * Make a pass's summary report the stored score: the score after the arrow in its "match X -> Y"
 * becomes the stored one (the "before" is the pass's own first check); without one, it's added.
 */
export const withStoredScore = (summary: string, m: Pick<ResumeMatch, 'score' | 'resumeVersion'>) => {
  let seen = false
  const fixed = summary.replace(MATCH_LINE, (_all, lead: string, before: string, arrow: string, _after: string, outOf: string | undefined) => (seen ? '' : ((seen = true), `${lead}${before}${arrow}${m.score}${outOf ?? ''}`)))
  return seen ? fixed : `${summary.trimEnd()}\nMatch: ${m.score}/100.`
}

/**
 * The stored match as agents read it: the score with the rubric points behind it, each
 * requirement's verdict, whether the resume changed since, and whether the last re-check moved the
 * score by more than judgment noise.
 */
export const matchForAgent = (a: Pick<schema.Application, 'resumeId' | 'matchJson'>) => {
  const m = a.matchJson
  if (!m) return null
  const r = resumeForApplication(a)
  const change = m.previousScore == null ? null : m.score - m.previousScore
  return {
    score: m.score,
    rubricVersion: m.rubricVersion ?? 1,
    checkedAt: m.at,
    doc: m.doc,
    resumeVersion: m.resumeVersion,
    resumeChangedSince: !r || r.id !== m.doc || String(r.version) !== m.resumeVersion,
    previousScore: m.previousScore ?? null,
    scoreChange: change,
    noiseMargin: MATCH_NOISE_MARGIN,
    improvedBeyondNoise: change == null ? null : change > MATCH_NOISE_MARGIN,
    summary: m.summary,
    breakdown:
      m.breakdown?.map((c) => ({ criterion: c.criterion, label: c.label, points: c.points, max: c.max, gaps: c.gaps.map((g) => ({ id: g.id, short: g.short, level: g.level, lost: g.lost })) })) ??
      'Checked before rubric v2: re-run check_resume_match for the per-criterion breakdown.',
    requirements: m.requirements.map((r) => ({
      id: r.id,
      kind: r.kind,
      area: r.area ?? null,
      short: r.short,
      quote: r.quote,
      level: r.level,
      lines: r.evidence.map((e) => e.lineId),
      note: r.note,
      fix: r.fix,
    })),
  }
}
