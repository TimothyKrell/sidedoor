import { and, eq, inArray, isNull } from 'drizzle-orm'
import { extractProseSections } from '@sidedoor/shared/package-sections'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { newId, nowIso } from '../ids'
import { getMeta, setMeta } from '../settings'
import { enqueueTask } from './tasks'

/**
 * Stale drafts: when a profile document changes, sentences in things not yet sent can stop being
 * true ("I haven't built on Yjs" after Experience says they have). The stale-check task
 * (jobs/stale-check.ts) finds them; these commands keep the flags. Flags never change the draft.
 */

/** Documents whose facts end up in drafts. Search criteria, writing style and tells don't. */
export const STALE_DOCS = ['experience', 'answers', 'stories'] as const
export type StaleDoc = (typeof STALE_DOCS)[number]
export const isStaleDoc = (key: string): key is StaleDoc => (STALE_DOCS as readonly string[]).includes(key)

/** Stages whose package hasn't gone to the company yet. */
const UNSUBMITTED: schema.ApplicationStage[] = ['interested', 'review', 'approved']

/** Lets several quick saves (or an agent's appends) share one check. */
const SETTLE_MS = 2 * 60_000

// --- what the last check saw -----------------------------------------------------------------

const snapshotKey = (key: StaleDoc) => `staleChecked:${key}`
/** The document as the last check saw it; the next check reads only what changed since. */
export const checkedSnapshot = (key: StaleDoc) => getMeta<string>(snapshotKey(key))
export const setCheckedSnapshot = (key: StaleDoc, body: string) => setMeta(snapshotKey(key), body)

const waitingCheck = (key: StaleDoc) =>
  db
    .select()
    .from(schema.tasks)
    .where(and(eq(schema.tasks.kind, 'stale-check'), eq(schema.tasks.status, 'queued')))
    .all()
    .find((t) => t.input.docKey === key)

/**
 * A profile document was saved. Queue a check of unsent drafts against what changed; a check
 * already waiting covers this edit too, since it diffs from the last checked version.
 */
export const docChanged = (key: string, before: string, after: string) => {
  if (!isStaleDoc(key) || before === after) return
  if (checkedSnapshot(key) === undefined) setCheckedSnapshot(key, before)
  if (waitingCheck(key)) return
  enqueueTask('stale-check', `Check unsent drafts against ${TITLES[key]}`, { input: { docKey: key }, dedupe: false, runAfter: new Date(Date.now() + SETTLE_MS).toISOString() })
}

const TITLES: Record<StaleDoc, string> = { experience: 'Experience', answers: 'Standard answers', stories: 'Story bank' }

/**
 * Check now, on request. `full` compares against the whole document rather than what changed
 * since the last check (more AI work; use after a big rewrite or when nothing was checked yet).
 */
export const checkStaleNow = (keys: readonly StaleDoc[] = STALE_DOCS, o: { full?: boolean } = {}) =>
  keys.map((key) => {
    const waiting = waitingCheck(key)
    if (waiting && !o.full) {
      db.update(schema.tasks).set({ runAfter: null, priority: Math.max(waiting.priority, 10) }).where(eq(schema.tasks.id, waiting.id)).run()
      return { docKey: key, taskId: waiting.id }
    }
    const t = enqueueTask('stale-check', `Check unsent drafts against ${TITLES[key]}`, { input: { docKey: key, ...(o.full ? { full: true } : {}) }, dedupe: false, priority: 10 })
    return { docKey: key, taskId: t.id }
  })

// --- what can go stale --------------------------------------------------------------------------

/** Something not yet sent, as text to check. Key: `draft:<id>` or `pkg:<applicationId>:<section>`. */
export interface StaleTarget {
  key: string
  draftId: string | null
  applicationId: string | null
  section: string | null
  label: string
  text: string
}

/** Unsent outreach drafts, and the cover letters and answers of applications not yet submitted. */
export const staleTargets = (): StaleTarget[] => {
  const drafts = db
    .select({ d: schema.drafts, name: schema.people.name })
    .from(schema.drafts)
    .leftJoin(schema.people, eq(schema.people.id, schema.drafts.personId))
    .where(eq(schema.drafts.status, 'draft'))
    .all()
    .map(({ d, name }) => ({
      key: `draft:${d.id}`,
      draftId: d.id,
      applicationId: d.applicationId,
      section: null,
      label: `${d.channel} draft${name ? ` to ${name}` : ''}`,
      text: [d.subject ? `Subject: ${d.subject}` : null, d.body].filter(Boolean).join('\n\n'),
    }))
  const apps = db.select().from(schema.applications).where(inArray(schema.applications.stage, UNSUBMITTED)).all().filter((a) => a.packageMd?.trim())
  const packages = apps.flatMap((a) => {
    const md = a.packageMd!
    const prose = extractProseSections(md)
    const sections = prose.map((s) => ({ key: `pkg:${a.id}:${s.key}`, draftId: null, applicationId: a.id, section: s.key, label: `${a.companyName} – ${a.role}: ${s.title}`, text: s.text }))
    // The rest (short form answers, notes) as one more piece.
    let rest = md
    for (const s of [...prose].sort((x, y) => y.start - x.start)) rest = rest.slice(0, s.start) + rest.slice(s.end)
    return rest.trim() ? [...sections, { key: `pkg:${a.id}:rest`, draftId: null, applicationId: a.id, section: null, label: `${a.companyName} – ${a.role}: package`, text: rest.trim() }] : sections
  })
  return [...drafts, ...packages]
}

/** For comparing a quoted sentence with the text: case, spacing and markdown emphasis don't matter. */
export const normalizeText = (s: string) =>
  s
    .replace(/[*_`]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()

/**
 * Two quotes of the same flagged line: one check may quote "- [x] EEO: decline veteran status. Change
 * it if you like." and the next just "EEO: decline veteran status.".
 */
const sameSentence = (a: string, b: string) => {
  const bare = (s: string) => normalizeText(s).replace(/^(?:[-*+]|\d+[.)])\s+/, '').replace(/^\[[ x]\]\s+/, '')
  const x = bare(a)
  const y = bare(b)
  return x === y || (Math.min(x.length, y.length) >= 30 && (x.includes(y) || y.includes(x)))
}

// --- flags ---------------------------------------------------------------------------------------

export interface NewStaleFlag {
  draftId: string | null
  applicationId: string | null
  section: string | null
  docKey: string
  sentence: string
  fact: string
  suggestion?: string | null
  taskId?: string | null
}

const sameTarget = (f: Pick<schema.StaleFlag, 'draftId' | 'applicationId'>) =>
  f.draftId ? eq(schema.staleFlags.draftId, f.draftId) : and(isNull(schema.staleFlags.draftId), eq(schema.staleFlags.applicationId, f.applicationId ?? ''))

/** Record flags, skipping a sentence that's already flagged and open. Returns the ones added. */
export const addStaleFlags = atomic((flags: NewStaleFlag[]) => {
  const added: schema.StaleFlag[] = []
  for (const f of flags) {
    const open = db
      .select()
      .from(schema.staleFlags)
      .where(and(eq(schema.staleFlags.status, 'open'), sameTarget(f)))
      .all()
    if (open.some((o) => sameSentence(o.sentence, f.sentence))) continue
    const row = {
      id: newId('stale_'),
      draftId: f.draftId,
      applicationId: f.applicationId,
      section: f.section,
      docKey: f.docKey,
      sentence: f.sentence.trim(),
      fact: f.fact.trim(),
      suggestion: f.suggestion?.trim() || null,
      taskId: f.taskId ?? null,
      createdAt: nowIso(),
    }
    db.insert(schema.staleFlags).values(row).run()
    added.push(db.select().from(schema.staleFlags).where(eq(schema.staleFlags.id, row.id)).get()!)
  }
  return added
})

/** The user or an agent dealt with it (fixed the text, or it's fine as written). */
export const clearStaleFlag = atomic((id: string, note?: string | null) => {
  const f = db.select().from(schema.staleFlags).where(eq(schema.staleFlags.id, id)).get()
  if (!f) throw new Error(`No stale-draft flag ${id}`)
  if (f.status !== 'open') return f
  db.update(schema.staleFlags).set({ status: 'cleared', note: note?.trim() || null, clearedAt: nowIso() }).where(eq(schema.staleFlags.id, id)).run()
  return db.select().from(schema.staleFlags).where(eq(schema.staleFlags.id, id)).get()!
})

/**
 * Open flags whose sentence is gone (the text was fixed), or whose draft was sent, discarded or
 * submitted, resolve themselves: there's nothing left to fix. So does a later flag on a sentence
 * that's already flagged.
 */
const resolveSettled = atomic(() => {
  const open = db.select().from(schema.staleFlags).where(eq(schema.staleFlags.status, 'open')).orderBy(schema.staleFlags.createdAt).all()
  if (!open.length) return
  const texts = new Map<string, string>()
  for (const t of staleTargets()) {
    const k = t.draftId ? `d:${t.draftId}` : `a:${t.applicationId}`
    texts.set(k, `${texts.get(k) ?? ''}\n${normalizeText(t.text)}`)
  }
  const kept: schema.StaleFlag[] = []
  for (const f of open) {
    const text = texts.get(f.draftId ? `d:${f.draftId}` : `a:${f.applicationId}`)
    const why = text === undefined ? (f.draftId ? 'The draft was sent or discarded' : 'The application was submitted or closed') : !text.includes(normalizeText(f.sentence)) ? 'The sentence was changed' : null
    const dup = !why && kept.some((k) => (k.draftId ?? `a:${k.applicationId}`) === (f.draftId ?? `a:${f.applicationId}`) && sameSentence(k.sentence, f.sentence))
    if (why || dup) db.update(schema.staleFlags).set({ status: 'resolved', note: why ?? 'Already flagged', clearedAt: nowIso() }).where(eq(schema.staleFlags.id, f.id)).run()
    else kept.push(f)
  }
})

export interface StaleFlagView extends schema.StaleFlag {
  /** Who the draft is to / which application, for lists. */
  label: string
  personId: string | null
}

/** Flags still to deal with (or every flag, with `all`), newest first. */
export const listStaleFlags = (o: { draftId?: string; applicationId?: string; all?: boolean } = {}): StaleFlagView[] => {
  resolveSettled()
  const F = schema.staleFlags
  const conds = [...(o.all ? [] : [eq(F.status, 'open')]), ...(o.draftId ? [eq(F.draftId, o.draftId)] : []), ...(o.applicationId ? [eq(F.applicationId, o.applicationId)] : [])]
  const rows = db
    .select({ f: F, personId: schema.drafts.personId, person: schema.people.name, company: schema.applications.companyName, role: schema.applications.role, channel: schema.drafts.channel })
    .from(F)
    .leftJoin(schema.drafts, eq(schema.drafts.id, F.draftId))
    .leftJoin(schema.people, eq(schema.people.id, schema.drafts.personId))
    .leftJoin(schema.applications, eq(schema.applications.id, F.applicationId))
    .where(conds.length ? and(...conds) : undefined)
    .all()
  return rows
    .map((r) => ({
      ...r.f,
      personId: r.personId,
      label: r.f.draftId ? `${r.channel ?? 'email'} draft${r.person ? ` to ${r.person}` : ''}${r.company ? ` (${r.company})` : ''}` : `${r.company ?? 'Application'}${r.role ? ` – ${r.role}` : ''}: ${r.f.section === 'cover-letter' ? 'cover letter' : r.f.section?.startsWith('q:') ? `answer ${r.f.section.slice(2)}` : 'package'}`,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
