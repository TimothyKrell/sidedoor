import { z } from 'zod'
import { logActivity } from '../activity'
import { runJob } from '../ai'
import type { schema } from '../db/client'
import { notifyPromise } from '../notify'
import { render } from '../prompts'
import { DOCS, docBody } from '../services/documents'
import { addStaleFlags, checkedSnapshot, isStaleDoc, normalizeText, setCheckedSnapshot, staleTargets } from '../services/stale-flags'
import { truncate } from '../text'
import type { TaskOutcome } from './tasks'

// Checks unsent drafts against what just changed in a profile document. Cheap by design: only the
// sentences that changed go to the AI, with only the drafts that share a distinctive word with
// them. An edit nothing unsent talks about never reaches the AI at all.

const sentences = (md: string) =>
  md
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9"'(*_-])/)
    .map((s) => s.replace(/^\s*(?:[-*+]|\d+[.)]|#+)\s+/, '').trim())
    .filter((s) => /[A-Za-z0-9]/.test(s))

/** Sentences added and removed between two versions (order doesn't matter, repeats do). */
export const docDiff = (before: string, after: string) => {
  const count = (xs: string[]) => {
    const m = new Map<string, { text: string; n: number }>()
    for (const s of xs) {
      const k = normalizeText(s)
      const e = m.get(k)
      if (e) e.n++
      else m.set(k, { text: s, n: 1 })
    }
    return m
  }
  const a = count(sentences(before))
  const b = count(sentences(after))
  const minus = (x: typeof a, y: typeof a) => [...x].flatMap(([k, e]) => Array<string>(Math.max(0, e.n - (y.get(k)?.n ?? 0))).fill(e.text))
  return { added: minus(b, a), removed: minus(a, b) }
}

// Words too common in job-search writing to say two texts are about the same thing.
const COMMON = new Set(
  `the and for with that this from have has had not but are was were been being you your our their they them his her its who what when where which while will would could should can may might must
  into onto over under about after before than then also just only very more most much many some any each every all both few other such own same into out off per via yet still even ever never
  work worked working works team teams build built building builds make made making use used using lead led leading manage managed managing
  year years month months time role roles job jobs company companies experience experienced project projects product products engineer engineers engineering
  help helped new now one two three first last next well good great like love know think want looking look`.split(/\s+/),
)

const stem = (w: string) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w)

/** Distinctive words: names of tools, companies, numbers, domain terms. */
export const termsOf = (text: string) =>
  new Set(
    (text.match(/[A-Za-z0-9][A-Za-z0-9+#.'’-]*[A-Za-z0-9+#]|[A-Za-z0-9]/g) ?? [])
      .map((w) => w.toLowerCase().replace(/’/g, "'"))
      .filter((w) => (w.length >= 3 || /\d/.test(w)) && !COMMON.has(w) && !w.includes("'"))
      .map(stem),
  )

const StaleOut = z.object({
  flags: z
    .array(
      z.object({
        key: z.string(),
        sentence: z.string(),
        fact: z.string(),
        suggestion: z.string().nullish(),
      }),
    )
    .default([]),
})

const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '(nothing)')

export const runStaleCheck = async (task: schema.Task): Promise<TaskOutcome> => {
  const key = task.input.docKey
  if (typeof key !== 'string' || !isStaleDoc(key)) throw new Error(`Not a document drafts are checked against: ${String(key)}`)
  const after = docBody(key)
  const before = task.input.full === true ? '' : (checkedSnapshot(key) ?? '')
  const diff = docDiff(before, after)
  const done = (output: string, extra: Partial<TaskOutcome> = {}) => {
    setCheckedSnapshot(key, after)
    return { output, ...extra }
  }
  if (!diff.added.length && !diff.removed.length) return done('Nothing changed since the last check.')
  const terms = termsOf([...diff.added, ...diff.removed].join('\n'))
  const targets = staleTargets().filter((t) => [...termsOf(t.text)].some((w) => terms.has(w)))
  if (!targets.length) return done(`${diff.added.length} added and ${diff.removed.length} removed sentence(s); no unsent draft mentions them.`)

  const title = DOCS[key].title
  const prompt = render('stale-check', {
    DOC_TITLE: title,
    // Generous: a full check sends the whole document, and its newest sections are at the end.
    ADDED: truncate(list(diff.added), 80_000),
    REMOVED: truncate(list(diff.removed), 20_000),
    ITEMS: targets.map((t) => `### Piece key="${t.key}" (${t.label})\n<<<TEXT\n${truncate(t.text, 6_000)}\nTEXT>>>`).join('\n\n'),
  })
  const r = await runJob({ job: 'stale', prompt, schema: StaleOut, maxTurns: 3, timeoutMs: 10 * 60_000 })
  const byKey = new Map(targets.map((t) => [t.key, t]))
  const kept = r.data.flags.flatMap((f) => {
    const t = byKey.get(f.key)
    // Only pieces we sent, and only sentences that are really in them.
    if (!t || !f.sentence.trim() || !normalizeText(t.text).includes(normalizeText(f.sentence))) return []
    return [{ draftId: t.draftId, applicationId: t.applicationId, section: t.section, docKey: key, sentence: f.sentence, fact: f.fact, suggestion: f.suggestion ?? null, taskId: task.id }]
  })
  const added = addStaleFlags(kept)
  const meta = { sessionId: r.sessionId, costUsd: r.costUsd ?? undefined, log: [...r.log, `${r.data.flags.length} flag(s) returned, ${kept.length} found in the text, ${added.length} new`], provider: r.provider, model: r.model }
  if (added.length) {
    const what = `${added.length} sentence${added.length === 1 ? '' : 's'} in unsent drafts may be out of date`
    const detail = added.map((f) => `“${truncate(f.sentence, 120)}” → ${truncate(f.fact, 120)}`).join(' · ')
    logActivity('outreach', `${title} changed: ${what}`, { detail: truncate(detail, 600), link: '/people' })
    await notifyPromise({ kind: 'agent', title: `Check your drafts: ${what}`, body: truncate(detail, 400), path: '/people', priority: 3, dedupeKey: `stale:${task.id}` })
  }
  return done(added.length ? `Flagged ${added.length} sentence(s) in ${new Set(added.map((f) => f.draftId ?? f.applicationId)).size} unsent piece(s).` : `Checked ${targets.length} unsent piece(s); nothing out of date.`, meta)
}
