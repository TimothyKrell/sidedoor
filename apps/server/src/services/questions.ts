import { and, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm'
import { holdsApplication, packageQuestions } from '@sidedoor/shared/questions'
import { logActivity } from '../activity'
import { db, schema } from '../db/client'
import { atomic } from '../db/tx'
import { isDemographic, type Settled } from '../form-answers'
import { newId, nowIso } from '../ids'
import { getMeta, getSettings, setMeta } from '../settings'
import { truncate } from '../text'
import { getApplication, requestChanges, requestSubmit, submitByOf, submitterAllowed, updateApplication } from './applications'
import { type DocKey, getDoc, setDoc } from './documents'

/**
 * Questions only the user can answer, kept one per question and application (schema.questions).
 * Prep, form fills and agents ask through `askQuestions`, which hands back answers the user
 * already gave instead of asking again. An answer goes into that application's package, and one
 * that holds for every application also into its own section of Standard answers or Experience,
 * where the user can see and change it.
 */

const Q = schema.questions
type Question = schema.Question
export type SaveTo = NonNullable<Question['saveTo']>
export type About = Question['about']

/** The question as words only, to find it when it's asked again with other punctuation or a hint like "(yes/no)". */
export const questionKey = (s: string) =>
  s
    .toLowerCase()
    .replace(/[*_`~]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const clean = (s: string) =>
  s
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:\d+[.)]|[-*])\s+/, '')
    .replace(/\s+/g, ' ')
    .trim()

const FORM_ANSWER = /salary|compensation|pay expectation|start date|notice period|relocat|sponsor|visa|authori[sz]|citizen|permanent resident|clearance|pronoun|gender|veteran|disabilit|ethnicity|how did you hear/i
const ABOUT_PAST = /\b(did|have|had|were|was)\s+you\b|\b(your|you) (role|experience|background|work)\b|\bhave you (ever )?(used|built|led|shipped|managed|worked)\b/i

/** A first guess at what a question is about, for questions asked without saying. */
export const guessAbout = (text: string): { about: About; saveTo: SaveTo | null } =>
  FORM_ANSWER.test(text) || isDemographic(text) ? { about: 'you', saveTo: 'answers' } : ABOUT_PAST.test(text) ? { about: 'you', saveTo: 'experience' } : { about: 'application', saveTo: null }

// ------------------------------------------------------------------ markdown sections

const sectionOf = (lines: string[], heading: RegExp) => {
  const start = lines.findIndex((l) => heading.test(l.trim()))
  if (start < 0) return null
  let end = start + 1
  while (end < lines.length && !/^#{1,2}\s/.test(lines[end]!)) end++
  return { start, end }
}

/**
 * Put one entry in a section of a markdown document, replacing the entry `isStart` finds (it runs
 * until `isNext`), or take it out when `entry` is null. The section is created at the end when
 * missing, and removed once it's empty.
 */
const upsertIn = (md: string, o: { heading: RegExp; title: string; isStart: (l: string) => boolean; isNext: (l: string) => boolean; entry: string[] | null }) => {
  const lines = md.replace(/\s*$/, '').split('\n')
  const s = sectionOf(lines, o.heading)
  if (!s) return o.entry ? `${md.trim() ? `${lines.join('\n')}\n\n` : ''}${o.title}\n\n${o.entry.join('\n')}\n` : md
  let at = -1
  for (let i = s.start + 1; i < s.end; i++)
    if (o.isStart(lines[i]!)) {
      at = i
      break
    }
  if (at >= 0) {
    let stop = at + 1
    while (stop < s.end && !o.isNext(lines[stop]!)) stop++
    while (stop > at + 1 && !lines[stop - 1]!.trim()) stop--
    lines.splice(at, stop - at, ...(o.entry ?? []))
    if (!o.entry && lines[at - 1] !== undefined && !lines[at - 1]!.trim() && lines[at] !== undefined && !lines[at]!.trim()) lines.splice(at, 1)
  } else if (o.entry) {
    let end = s.end
    while (end > s.start + 1 && !lines[end - 1]!.trim()) end--
    lines.splice(end, 0, '', ...o.entry, ...(end < lines.length ? [''] : []))
  }
  const now = sectionOf(lines, o.heading)!
  if (lines.slice(now.start + 1, now.end).every((l) => !l.trim())) lines.splice(now.start, now.end - now.start)
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
}

const PKG = { heading: /^##\s+(your answers to questions|answers to the other form questions)\s*$/i, title: '## Your answers to questions' }
const DOC = { heading: /^##\s+answers to questions\s*$/i, title: '## Answers to questions' }

/** The package with this answer under "Your answers to questions" (what the form filler and the next prep read), or without it. */
export const packageWithAnswer = (md: string, question: string, answer: string | null) =>
  upsertIn(md, {
    ...PKG,
    isStart: (l) => l.trim().toLowerCase() === `### ${question}`.toLowerCase(),
    isNext: (l) => /^#{1,3}\s/.test(l),
    entry: answer == null ? null : [`### ${question}`, answer.trim()],
  })

/** A profile document with this answer as one line of its "Answers to questions" section, or without it. */
export const docWithAnswer = (md: string, question: string, answer: string | null) =>
  upsertIn(md, {
    ...DOC,
    isStart: (l) => l.startsWith(`- **${question}**`),
    isNext: (l) => /^([-*]\s|#)/.test(l),
    entry: answer == null ? null : [`- **${question}** ${answer.replace(/\s+/g, ' ').trim()}`],
  })

const putInPackage = (applicationId: string, question: string, answer: string | null) => {
  const a = getApplication(applicationId)
  // No package yet: prep writes one and save_package adds the answers then.
  if (!a?.packageMd) return
  const md = packageWithAnswer(a.packageMd, question, answer)
  if (md !== a.packageMd) updateApplication(applicationId, { packageMd: md })
}

const putInDoc = (key: DocKey, question: string, answer: string | null) => {
  const d = getDoc(key)
  const base = d.isDefault ? '' : d.body
  const md = docWithAnswer(base, question, answer)
  if (md !== base && (answer != null || !d.isDefault)) setDoc(key, md)
}

// ------------------------------------------------------------------ asking

export interface AskInput {
  question: string
  /** 'you': about the user. 'application': only about this job. Guessed when not given. */
  about?: About
  why?: string | null
  options?: string[]
  /** What the fill put in the field it held back. */
  filledValue?: string | null
  /** For questions about the user: where an answer for every application is kept. */
  saveTo?: SaveTo | null
}

export interface Asked {
  id: string
  question: string
  status: schema.QuestionStatus
  answer: string | null
  /** Answered before (here or, for every application, elsewhere): use the answer, don't ask. */
  known: boolean
}

const byId = (id: string) => db.select().from(Q).where(eq(Q.id, id)).get()

/** The answer the user gave for every application, if they've answered this question before. */
const knownForAll = (key: string) => db.select().from(Q).where(and(eq(Q.key, key), eq(Q.scope, 'global'), eq(Q.status, 'answered'))).orderBy(desc(Q.answeredAt)).get()

/** The user marked this question not needed, on any application. */
const passedOn = (key: string) => db.select({ id: Q.id }).from(Q).where(and(eq(Q.key, key), eq(Q.status, 'dismissed'))).get()

/**
 * Ask the user some questions, for one application or (applicationId null) in general. A question
 * already answered for every application isn't asked again: it's recorded as answered here too,
 * and its answer comes back. One asked again for the same application keeps its row. A fact the
 * user already said wasn't needed isn't asked of another application, unless a form needs it.
 * A fill asking comes back even after a "Not needed": it's still waiting on the field, and the
 * user has to see that, or the form stops with nothing to answer.
 */
export const askQuestions = atomic((applicationId: string | null, askedBy: string, qs: AskInput[]): Asked[] => {
  if (applicationId && !getApplication(applicationId)) throw new Error(`No application ${applicationId}`)
  const out: Asked[] = []
  for (const x of qs) {
    const text = clean(x.question)
    const key = questionKey(text)
    if (!key) continue
    const here = db
      .select()
      .from(Q)
      .where(and(eq(Q.key, key), applicationId ? eq(Q.applicationId, applicationId) : isNull(Q.applicationId)))
      .orderBy(desc(Q.createdAt))
      .get()
    if (here) {
      const back = here.status === 'dismissed' && askedBy === 'fill'
      if (back || (here.status === 'open' && (x.why || x.options?.length || x.filledValue)))
        db.update(Q)
          .set({ why: x.why ?? here.why, options: x.options?.length ? x.options : here.options, filledValue: x.filledValue ?? here.filledValue, updatedAt: nowIso(), ...(back ? { status: 'open' as const, answer: null, answeredAt: null, answeredBy: null } : {}) })
          .where(eq(Q.id, here.id))
          .run()
      const status = back ? 'open' : here.status
      out.push({ id: here.id, question: here.text, status, answer: here.answer, known: status !== 'open' })
      continue
    }
    const known = knownForAll(key)
    if (known && !applicationId) {
      out.push({ id: known.id, question: known.text, status: 'answered', answer: known.answer, known: true })
      continue
    }
    const guess = guessAbout(text)
    const about = x.about ?? guess.about
    const saveTo = x.saveTo ?? (about === 'you' ? (guess.saveTo ?? 'answers') : null)
    if (!known && !holdsApplication({ about, saveTo, askedBy })) {
      const passed = passedOn(key)
      if (passed) {
        out.push({ id: passed.id, question: text, status: 'dismissed', answer: null, known: false })
        continue
      }
    }
    const at = nowIso()
    const row: typeof Q.$inferInsert = {
      id: newId('q_'),
      applicationId,
      // About the user: suggested for every application; the user decides when answering.
      scope: about === 'you' || !applicationId ? 'global' : 'application',
      about,
      text,
      key,
      why: x.why ?? null,
      filledValue: x.filledValue ?? null,
      options: x.options ?? [],
      saveTo,
      askedBy,
      createdAt: at,
      updatedAt: at,
      ...(known ? { status: 'answered' as const, scope: 'global' as const, saveTo: known.saveTo, answer: known.answer, answeredAt: at, answeredBy: known.answeredBy } : {}),
    }
    db.insert(Q).values(row).run()
    if (known && applicationId) putInPackage(applicationId, text, known.answer)
    out.push({ id: row.id, question: text, status: known ? 'answered' : 'open', answer: known?.answer ?? null, known: !!known })
  }
  return out
})

// ------------------------------------------------------------------ answering

export interface AnswerInput {
  id: string
  answer: string
  /** The answer holds for every application: reused instead of asked again. Defaults to the question's scope. */
  allApplications?: boolean
  /** Where an answer for every application is kept. Defaults to the question's own (Standard answers for most). */
  saveTo?: SaveTo
}

/**
 * Record the user's answers. Each goes into its application's package. One for every application
 * also answers the same question still open in the others, and is kept in Standard answers or
 * Experience. When Grok Bot was submitting an application and these were the last questions its
 * form asked, the fill is queued again (unless `continueSubmit` is false).
 */
export const answerQuestions = atomic((items: AnswerInput[], by: string, o: { continueSubmit?: boolean } = {}) => {
  const touched = new Set<string>()
  const answered: string[] = []
  for (const x of items) {
    const q = byId(x.id)
    if (!q) throw new Error(`No question ${x.id}`)
    const answer = x.answer.trim()
    if (!answer) throw new Error(`Give an answer for "${q.text}", or dismiss it.`)
    const forAll = x.allApplications ?? q.scope === 'global'
    const saveTo = forAll ? (x.saveTo ?? q.saveTo ?? 'answers') : q.saveTo
    // For every application: the same question wherever it's open, and wherever this answer was already used.
    const rows = forAll ? db.select().from(Q).where(and(eq(Q.key, q.key), or(eq(Q.status, 'open'), and(eq(Q.scope, 'global'), eq(Q.status, 'answered'))))).all() : [q]
    if (!rows.some((r) => r.id === q.id)) rows.push(q)
    const at = nowIso()
    for (const r of rows) {
      db.update(Q)
        .set({ status: 'answered', answer, answeredAt: at, answeredBy: by, scope: forAll ? 'global' : 'application', saveTo, revisedAt: null, updatedAt: at })
        .where(eq(Q.id, r.id))
        .run()
      answered.push(r.id)
      if (r.applicationId) {
        putInPackage(r.applicationId, r.text, answer)
        touched.add(r.applicationId)
      }
    }
    if (forAll && saveTo) {
      // Moved from one document to the other: only one keeps it.
      if (q.scope === 'global' && q.saveTo && q.saveTo !== saveTo) putInDoc(q.saveTo, q.text, null)
      putInDoc(saveTo, q.text, answer)
    }
  }
  const resubmitted = o.continueSubmit === false ? [] : [...touched].filter(continueSubmit)
  const texts = [...new Set(items.map((x) => byId(x.id)?.text).filter(Boolean))]
  logActivity('application', `You answered ${texts.length} question${texts.length === 1 ? '' : 's'}${by === 'you' ? '' : ` (via ${by})`}`, {
    detail: texts.join('\n'),
    link: '/questions',
  })
  return { answered: [...new Set(answered)], applications: [...touched], resubmitted }
})

/**
 * Not to be asked: no answer goes anywhere, and an answer given before is taken back out. When the
 * user passes on the last question a form was waiting for, the fill is queued again, as it is for
 * an answer.
 */
export const dismissQuestions = atomic((ids: string[], by: string) => {
  const waiting = new Set<string>()
  for (const id of ids) {
    const q = byId(id)
    if (!q) throw new Error(`No question ${id}`)
    if (q.status === 'answered') takeBack(q)
    if (by === 'you' && q.status === 'open' && q.askedBy === 'fill' && q.applicationId) waiting.add(q.applicationId)
    db.update(Q).set({ status: 'dismissed', answer: null, answeredAt: nowIso(), answeredBy: by, updatedAt: nowIso() }).where(eq(Q.id, id)).run()
  }
  return { dismissed: ids, resubmitted: [...waiting].filter(continueSubmit) }
})

/**
 * What the form check should treat as dealt with, from the question rows: the package keeps an
 * item's text after its question is answered or dropped. Only the user's own "Not needed" lets a
 * held value through, and only the value they saw: agents answer instead.
 */
export const settledFor = (applicationId: string): Settled => {
  const rows = db.select().from(Q).where(and(eq(Q.applicationId, applicationId), inArray(Q.status, ['answered', 'dismissed']))).all()
  // Dropping a field a form held settles only that value (`passed`), not the item behind it.
  const keys = new Set(rows.filter((r) => r.status === 'answered' || (r.askedBy !== 'fill' && r.filledValue == null)).map((r) => r.key))
  const passed = new Set(rows.filter((r) => r.status === 'dismissed' && r.answeredBy === 'you' && r.filledValue != null).map((r) => `${r.key}\n${r.filledValue!.trim()}`))
  return {
    // As a package item becomes a question: what follows its last "?" is why it's asked.
    item: (text) => keys.has(questionKey(text)) || keys.has(questionKey(text.replace(/\?[^?]*$/, '?'))),
    passed: (field, value) => passed.has(`${questionKey(field)}\n${value.trim()}`),
  }
}

const takeBack = (q: Question) => {
  if (q.applicationId) putInPackage(q.applicationId, q.text, null)
  if (q.scope === 'global' && q.saveTo && !db.select().from(Q).where(and(eq(Q.key, q.key), eq(Q.scope, 'global'), eq(Q.status, 'answered'), ne(Q.id, q.id))).get()) putInDoc(q.saveTo, q.text, null)
}

/** Ask it again. An answer for every application is taken back everywhere it was used. */
export const reopenQuestion = atomic((id: string) => {
  const q = byId(id)
  if (!q) throw new Error(`No question ${id}`)
  const rows = q.status === 'answered' && q.scope === 'global' ? db.select().from(Q).where(and(eq(Q.key, q.key), eq(Q.scope, 'global'), eq(Q.status, 'answered'))).all() : [q]
  for (const r of rows) {
    if (r.applicationId) putInPackage(r.applicationId, r.text, null)
    db.update(Q).set({ status: 'open', answer: null, answeredAt: null, answeredBy: null, revisedAt: null, updatedAt: nowIso() }).where(eq(Q.id, r.id)).run()
  }
  if (q.scope === 'global' && q.saveTo && q.status === 'answered') putInDoc(q.saveTo, q.text, null)
  return byId(id)!
})

/** A submit stopped for questions, and none of the form's is left open: fill (and submit) it again. */
const continueSubmit = (applicationId: string) => {
  const T = schema.tasks
  const last = db.select().from(T).where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, applicationId))).orderBy(desc(T.createdAt)).get()
  if (!last || last.input.submit !== true || last.status !== 'done' || !last.output) return false
  const by = submitByOf(last.input)
  if (!submitterAllowed(by)) return false
  let waiting = false
  try {
    const o = JSON.parse(last.output) as { outcome?: string; submit?: { problems?: unknown[] } | null }
    waiting = o.submit ? (o.submit.problems?.length ?? 0) > 0 : o.outcome === 'needs_you'
  } catch {
    return false
  }
  if (!waiting) return false
  if (db.select().from(Q).where(and(eq(Q.applicationId, applicationId), eq(Q.askedBy, 'fill'), eq(Q.status, 'open'))).get()) return false
  try {
    requestSubmit(applicationId, { dryRun: last.input.dryRun === true, by, skipRuleCheck: true, closeWhenDone: last.input.closeWhenDone === true })
    return true
  } catch (e) {
    console.error('[questions] could not continue the submit', e)
    return false
  }
}

// ------------------------------------------------------------------ packages

/** Questions in a package's "Questions for" section, kept as questions (those answered in it, as answered). */
const importFromPackage = (applicationId: string, md: string) => {
  for (const pq of packageQuestions(md)) {
    const [asked] = askQuestions(applicationId, 'package', [{ question: pq.text, why: pq.why }])
    if (asked && pq.answer && asked.status === 'open')
      db.update(Q).set({ status: 'answered', scope: 'application', answer: pq.answer, answeredAt: nowIso(), answeredBy: 'package', updatedAt: nowIso() }).where(eq(Q.id, asked.id)).run()
  }
}

/**
 * Save an application's package (save_package). Questions in its "Questions for" section become
 * questions to answer, and the answers already given stay in it, whatever the new text left out.
 */
export const savePackage = atomic((applicationId: string, packageMd: string) => {
  if (!getApplication(applicationId)) throw new Error('not found')
  importFromPackage(applicationId, packageMd)
  let md = packageMd
  for (const q of db.select().from(Q).where(and(eq(Q.applicationId, applicationId), eq(Q.status, 'answered'), ne(Q.answeredBy, 'package'))).all()) md = packageWithAnswer(md, q.text, q.answer)
  updateApplication(applicationId, { packageMd: md })
  return md
})

/** Once: the questions in packages saved before Sidedoor kept questions, for applications not sent yet. */
export const importPackageQuestions = atomic(() => {
  if (getMeta<boolean>('questionsImported')) return 0
  const A = schema.applications
  const rows = db
    .select({ id: A.id, packageMd: A.packageMd })
    .from(A)
    .where(inArray(A.stage, ['interested', 'review', 'approved']))
    .all()
  let n = 0
  for (const r of rows)
    if (r.packageMd && packageQuestions(r.packageMd).length) {
      importFromPackage(r.id, r.packageMd)
      n++
    }
  setMeta('questionsImported', true)
  return n
})

/**
 * Send the package back to the AI to use the answers given since, changing only what they affect
 * (a targeted revision, not a new package). The resume match is checked again after.
 */
export const reviseWithAnswers = atomic((applicationId: string) => {
  const a = getApplication(applicationId)
  if (!a) throw new Error(`No application ${applicationId}`)
  const fresh = db.select().from(Q).where(and(eq(Q.applicationId, applicationId), eq(Q.status, 'answered'), isNull(Q.revisedAt), ne(Q.answeredBy, 'package'))).all()
  if (!fresh.length) throw new Error('No new answers to use.')
  requestChanges(
    applicationId,
    `Targeted update with my answers, not a new package: change only what these answers affect (resume lines, form answers, the summary, "Needs your decision"), keep everything else as it is, and don't redo the research.\n${fresh.map((q) => `- Q: ${q.text}\n  A: ${q.answer}`).join('\n')}`,
  )
  db.update(Q).set({ revisedAt: nowIso() }).where(inArray(Q.id, fresh.map((q) => q.id))).run()
  return { answers: fresh.length }
})

// ------------------------------------------------------------------ reads

/**
 * What's been put to the user about themselves and not answered, for an AI about to ask: what they
 * passed on first, so a long list keeps those. Words differ from job to job, so `askQuestions` can
 * only catch the same wording; the AI has to see the rest to leave the topic alone.
 */
export const askedBefore = () => {
  const rows = db
    .select({ text: Q.text, key: Q.key, status: Q.status })
    .from(Q)
    .where(and(eq(Q.about, 'you'), ne(Q.askedBy, 'fill'), inArray(Q.status, ['dismissed', 'open'])))
    .orderBy(desc(Q.updatedAt))
    .all()
  const seen = new Set<string>()
  return [...rows.filter((r) => r.status === 'dismissed'), ...rows.filter((r) => r.status === 'open')]
    .filter((r) => !seen.has(r.key) && seen.add(r.key))
    .map((r) => `- ${r.status === 'dismissed' ? 'Passed on' : 'Waiting'}: ${truncate(r.text, 120)}`)
    .join('\n')
}

/** Answers the user gave that prep should use: for every application, and for this one. */
export const answersFor = (applicationId: string | null) => {
  const rows = db
    .select()
    .from(Q)
    .where(and(eq(Q.status, 'answered'), applicationId ? or(eq(Q.scope, 'global'), eq(Q.applicationId, applicationId)) : eq(Q.scope, 'global')))
    .orderBy(desc(Q.answeredAt))
    .all()
  const seen = new Set<string>()
  return rows.filter((r) => {
    // This application's own answer wins over the one for every application.
    const k = r.key
    if (seen.has(k)) return false
    if (r.scope === 'global' && applicationId && rows.some((o) => o.key === k && o.applicationId === applicationId && o.scope === 'application')) return false
    seen.add(k)
    return true
  })
}

export interface QuestionFilter {
  status?: schema.QuestionStatus | 'all'
  applicationId?: string
  about?: About
  /** Include open questions of applications already sent or closed (left out by default). */
  includeSent?: boolean
  limit?: number
}

export interface QuestionGroup {
  /** The question's rows: one per application that asked it. */
  ids: string[]
  /** The row to answer, dismiss or reopen. */
  id: string
  question: string
  about: About
  scope: Question['scope']
  saveTo: Question['saveTo']
  why: string | null
  /** What the fill put in the field it held back. */
  filledValue: string | null
  options: string[]
  status: schema.QuestionStatus
  answer: string | null
  answeredAt: string | null
  answeredBy: string | null
  askedBy: string
  askedAt: string
  /** Answered since the package was last sent to be revised. */
  unrevised: boolean
  /** Could make the application stronger, but nothing waits on it (see `holdsApplication`). */
  optional: boolean
  applications: { id: string; name: string; stage: schema.ApplicationStage }[]
}

const UNSENT: schema.ApplicationStage[] = ['interested', 'review', 'approved']

/**
 * Questions, the same one asked by several applications shown once. Open ones of applications
 * already sent or closed are left out unless asked for.
 */
export const listQuestions = (f: QuestionFilter = {}): QuestionGroup[] => {
  const A = schema.applications
  const conds = []
  if (f.status && f.status !== 'all') conds.push(eq(Q.status, f.status))
  if (f.applicationId) conds.push(eq(Q.applicationId, f.applicationId))
  if (f.about) conds.push(eq(Q.about, f.about))
  const rows = db
    .select({ q: Q, companyName: A.companyName, role: A.role, stage: A.stage })
    .from(Q)
    .leftJoin(A, eq(A.id, Q.applicationId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(Q.updatedAt))
    .all()
    .filter((r) => f.includeSent || f.applicationId || r.q.status !== 'open' || !r.stage || UNSENT.includes(r.stage))
  const groups = new Map<string, QuestionGroup>()
  for (const { q, companyName, role, stage } of rows) {
    // Answered for every application: one entry. Otherwise one per answer, open ones by question.
    const k = q.status === 'open' ? `open:${q.key}:${q.filledValue ?? ''}` : q.scope === 'global' && q.status === 'answered' ? `all:${q.key}` : q.id
    let g = groups.get(k)
    if (!g) {
      g = {
        ids: [],
        id: q.id,
        question: q.text,
        about: q.about,
        scope: q.scope,
        saveTo: q.saveTo,
        why: q.why,
        filledValue: q.filledValue,
        options: q.options,
        status: q.status,
        answer: q.answer,
        answeredAt: q.answeredAt,
        answeredBy: q.answeredBy,
        askedBy: q.askedBy,
        askedAt: q.createdAt,
        unrevised: false,
        optional: true,
        applications: [],
      }
      groups.set(k, g)
    }
    if (holdsApplication(q)) g.optional = false
    g.ids.push(q.id)
    if (q.status === 'answered' && !q.revisedAt && q.answeredBy !== 'package') g.unrevised = true
    if (!g.why && q.why) g.why = q.why
    if (!g.options.length && q.options.length) g.options = q.options
    if (q.applicationId && stage && !g.applications.some((a) => a.id === q.applicationId)) g.applications.push({ id: q.applicationId, name: `${companyName} – ${role}`, stage })
  }
  const out = [...groups.values()]
  return f.limit ? out.slice(0, f.limit) : out
}

export const openQuestionCount = () => listQuestions({ status: 'open' }).filter((q) => !q.optional).length

// ------------------------------------------------------------------ Grok Bot's answer_questions

export interface FormAnswer {
  question: string
  answer: string
  /** True when it's about the user, not this job (salary, start date, relocation): kept for every application too. */
  reusable?: boolean
}

/**
 * The user's answers, relayed by Grok Bot, to questions a form asked that the package didn't
 * cover. Each is recorded against the question the fill asked (or a new one), so it lands in the
 * package; reusable ones are kept for every application, in Standard answers. Then the application
 * is sent to be filled again: submitted, or another dry run when that's what it was last sent for.
 */
export const answerFormQuestions = atomic((id: string, answers: FormAnswer[], from: 'agent' | 'grokbot' = 'grokbot') => {
  const a = getApplication(id)
  if (!a) throw new Error(`No application ${id}`)
  const given = answers.map((x) => ({ ...x, question: x.question.trim(), answer: x.answer.trim() })).filter((x) => x.question && x.answer)
  if (!given.length) throw new Error('Give at least one question with its answer.')
  const items: AnswerInput[] = []
  for (const x of given) {
    // Self-identification answers are about them, whatever the caller said: the next form shouldn't ask.
    const reusable = x.reusable === true || isDemographic(x.question)
    const [asked] = askQuestions(id, 'fill', [{ question: x.question, ...(reusable ? { about: 'you' as const, saveTo: 'answers' as const } : {}) }])
    if (!asked || (asked.status === 'answered' && asked.answer === x.answer)) continue
    items.push({ id: asked.id, answer: x.answer, allApplications: reusable, ...(reusable ? { saveTo: 'answers' as const } : {}) })
  }
  if (items.length) answerQuestions(items, from, { continueSubmit: false })
  const T = schema.tasks
  const last = db.select().from(T).where(and(eq(T.kind, 'submit-assist'), eq(T.applicationId, id))).orderBy(desc(T.createdAt)).get()
  // The fill checks the rules again before it clicks submit; failing here would lose the answers.
  return requestSubmit(id, { dryRun: last?.input.dryRun === true, by: last?.input.by === 'you' ? 'you' : from, skipRuleCheck: true, closeWhenDone: last?.input.closeWhenDone === true })
})
