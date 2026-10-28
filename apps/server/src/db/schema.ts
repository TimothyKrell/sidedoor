import { sql } from 'drizzle-orm'
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { ResumeMatch } from '@sidedoor/shared/match'
import type { ResumeContent, ResumeNote, ThemeOptions } from '@sidedoor/shared/resume'

const id = () => text('id').primaryKey()
const createdAt = () => text('created_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
const updatedAt = () => text('updated_at').notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`)
const json = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

/** JSON-serializable value (server functions refuse `unknown`). */
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** One change the editor pass made, with its reason (writing-rules.md Part 2). */
export type EditorChange = { what: string; why: string }
/** Editor pass over a prep package's prose sections (cover letter, free-text answers). */
export type PackageEdit = {
  at: string
  model: string
  error?: string
  items: Array<{ key: string; title: string; original: string; edited: string; changes: EditorChange[]; rejected?: string }>
}

/** Companies we know about: from postings, funding news, research, or the old vault. */
export const companies = sqliteTable(
  'companies',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    domain: text('domain'),
    website: text('website'),
    description: text('description'),
    lanes: json<string[]>('lanes').notNull().default([]),
    /** Manual interest: -1 avoid, 0 neutral, 1 interested, 2 dream company. */
    interest: integer('interest').notNull().default(0),
    fundingStage: text('funding_stage'),
    fundingAmount: text('funding_amount'),
    fundingAt: text('funding_at'),
    fundingNote: text('funding_note'),
    fundingUrl: text('funding_url'),
    atsKind: text('ats_kind'),
    atsBoard: text('ats_board'),
    /** Last time we probed the common ATSs for this company's board (set even when none was found). */
    atsCheckedAt: text('ats_checked_at'),
    emailPattern: text('email_pattern'),
    /** Formats that bounced at this company, e.g. ['{first}']. find_email ranks them last. */
    badEmailPatterns: json<string[]>('bad_email_patterns'),
    notes: text('notes'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('companies_slug').on(t.slug)],
)

/** Job sources that the scout polls: ATS boards, aggregator feeds, HN, etc. */
export const sources = sqliteTable(
  'sources',
  {
    id: id(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    board: text('board').notNull(),
    url: text('url'),
    companyId: text('company_id'),
    status: text('status', { enum: ['active', 'candidate', 'paused', 'rejected'] }).notNull().default('candidate'),
    /** hot sources are polled on the fast interval. */
    tier: text('tier', { enum: ['hot', 'normal'] }).notNull().default('normal'),
    lanes: json<string[]>('lanes').notNull().default([]),
    why: text('why'),
    origin: text('origin'),
    lastCheckedAt: text('last_checked_at'),
    lastError: text('last_error'),
    lastJobCount: integer('last_job_count'),
    matchesTotal: integer('matches_total').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('sources_kind_board').on(t.kind, t.board)],
)

export type TriageDecision = 'queue' | 'maybe' | 'skip'
/** Can the user take this job given where they live and want to work? 'unclear' means no signal either way. */
export type LocationFit = 'ok' | 'unclear' | 'no'

/** Every posting the scout has ever seen. */
export const postings = sqliteTable(
  'postings',
  {
    id: id(),
    key: text('key').notNull(),
    sourceId: text('source_id'),
    companyId: text('company_id'),
    companyName: text('company_name'),
    title: text('title').notNull(),
    location: text('location'),
    url: text('url'),
    applyUrl: text('apply_url'),
    postedAt: text('posted_at'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    closedAt: text('closed_at'),
    compText: text('comp_text'),
    compMin: integer('comp_min'),
    compMax: integer('comp_max'),
    jd: text('jd'),
    /** 'pass' or 'fail: <reason>' from the cheap regex filter. */
    heuristic: text('heuristic'),
    triageStatus: text('triage_status', { enum: ['pending', 'done', 'skipped', 'error'] }).notNull().default('skipped'),
    decision: text('decision').$type<TriageDecision>(),
    fitScore: integer('fit_score'),
    lane: text('lane'),
    summary: text('summary'),
    reasons: json<string[]>('reasons'),
    gaps: json<string[]>('gaps'),
    locationFit: text('location_fit').$type<LocationFit>(),
    /** Why locationFit isn't 'ok', e.g. "Listed as Europe | Remote; no US mention". */
    locationNote: text('location_note'),
    triagedAt: text('triaged_at'),
    /** What the user did with it. */
    userStatus: text('user_status', { enum: ['new', 'starred', 'dismissed', 'tracked'] }).notNull().default('new'),
    notifiedAt: text('notified_at'),
    applicationId: text('application_id'),
    /** Aggregator page we first found this on, when url has been swapped for the company's own posting. */
    viaUrl: text('via_url'),
    /** When we last tried to find the company's own posting for an aggregator listing. */
    resolvedAt: text('resolved_at'),
  },
  (t) => [
    uniqueIndex('postings_key').on(t.key),
    index('postings_first_seen').on(t.firstSeenAt),
    index('postings_triage').on(t.triageStatus),
    index('postings_company').on(t.companyId),
  ],
)

export const APPLICATION_STAGES = [
  'interested',
  'review',
  'approved',
  'applied',
  'screening',
  'interviewing',
  'offer',
  'closed',
] as const
export type ApplicationStage = (typeof APPLICATION_STAGES)[number]

/** A role the user is pursuing. */
export const applications = sqliteTable(
  'applications',
  {
    id: id(),
    postingId: text('posting_id'),
    companyId: text('company_id'),
    companyName: text('company_name').notNull(),
    role: text('role').notNull(),
    stage: text('stage').$type<ApplicationStage>().notNull().default('interested'),
    status: text('status', { enum: ['potential', 'active', 'on-hold', 'closed-won', 'closed-lost'] })
      .notNull()
      .default('potential'),
    priority: text('priority', { enum: ['high', 'medium', 'low'] }).notNull().default('medium'),
    source: text('source'),
    jobUrl: text('job_url'),
    applyUrl: text('apply_url'),
    location: text('location'),
    compText: text('comp_text'),
    compMin: integer('comp_min'),
    compMax: integer('comp_max'),
    fitScore: integer('fit_score'),
    nextAction: text('next_action'),
    nextActionDate: text('next_action_date'),
    appliedAt: text('applied_at'),
    lastActivityAt: text('last_activity_at'),
    /** Application package (review sheet) in markdown. */
    packageMd: text('package_md'),
    /** The tailored resume for this application (resumes.id), once prep made one. */
    resumeId: text('resume_id'),
    /** The package as Claude first wrote it, before the editor pass. */
    packageOriginalMd: text('package_original_md'),
    editorJson: json<PackageEdit>('editor_json'),
    /** Requirements from the posting matched against the tailored resume (src/server/match.ts). */
    matchJson: json<ResumeMatch>('match_json'),
    reviewNotes: text('review_notes'),
    notesMd: text('notes_md'),
    closedReason: text('closed_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('applications_stage').on(t.stage), index('applications_company').on(t.companyId)],
)

export const PERSON_KINDS = ['recruiter', 'hiring-manager', 'founder', 'referral', 'network', 'interviewer', 'other'] as const
export type PersonKind = (typeof PERSON_KINDS)[number]
export const RELATIONSHIP_STAGES = ['not-contacted', 'contacted', 'replied', 'engaged', 'dormant'] as const
export type RelationshipStage = (typeof RELATIONSHIP_STAGES)[number]

export const people = sqliteTable(
  'people',
  {
    id: id(),
    name: text('name').notNull(),
    companyId: text('company_id'),
    companyName: text('company_name'),
    title: text('title'),
    kind: text('kind').$type<PersonKind>().notNull().default('other'),
    email: text('email'),
    /** verified | published | pattern | guessed */
    emailConfidence: text('email_confidence'),
    emailSource: text('email_source'),
    /** Addresses that bounced; never suggested or saved again. */
    bouncedEmails: json<string[]>('bounced_emails'),
    linkedin: text('linkedin'),
    x: text('x'),
    phone: text('phone'),
    stage: text('stage').$type<RelationshipStage>().notNull().default('not-contacted'),
    priority: text('priority', { enum: ['high', 'medium', 'low'] }).notNull().default('medium'),
    lastContactAt: text('last_contact_at'),
    nextContactAt: text('next_contact_at'),
    cadenceDays: integer('cadence_days'),
    nextAction: text('next_action'),
    whyMd: text('why_md'),
    notesMd: text('notes_md'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('people_company').on(t.companyId), index('people_next').on(t.nextContactAt)],
)

export const applicationPeople = sqliteTable(
  'application_people',
  {
    applicationId: text('application_id').notNull(),
    personId: text('person_id').notNull(),
    role: text('role'),
  },
  (t) => [primaryKey({ columns: [t.applicationId, t.personId] })],
)

/** Every touchpoint with a person (sent email, reply, call, LinkedIn DM, note). */
export const interactions = sqliteTable(
  'interactions',
  {
    id: id(),
    personId: text('person_id'),
    applicationId: text('application_id'),
    channel: text('channel').notNull().default('email'),
    direction: text('direction', { enum: ['out', 'in', 'note'] }).notNull().default('out'),
    summary: text('summary').notNull(),
    at: text('at').notNull(),
  },
  (t) => [index('interactions_person').on(t.personId), index('interactions_app').on(t.applicationId)],
)

/** Outreach drafts written by an agent or the user. The user always sends them. */
export const drafts = sqliteTable('drafts', {
  id: id(),
  personId: text('person_id'),
  applicationId: text('application_id'),
  channel: text('channel').notNull().default('email'),
  toEmail: text('to_email'),
  subject: text('subject'),
  body: text('body').notNull(),
  status: text('status', { enum: ['draft', 'sent', 'discarded'] }).notNull().default('draft'),
  author: text('author', { enum: ['agent', 'user'] }).notNull().default('agent'),
  /** The agent's first draft, before the editor pass rewrote `body`. Null when no editor pass ran. */
  originalBody: text('original_body'),
  editorChanges: json<EditorChange[]>('editor_changes'),
  editedAt: text('edited_at'),
  editorError: text('editor_error'),
  createdAt: createdAt(),
  sentAt: text('sent_at'),
})

export const research = sqliteTable('research', {
  id: id(),
  applicationId: text('application_id'),
  companyId: text('company_id'),
  title: text('title').notNull(),
  bodyMd: text('body_md').notNull(),
  taskId: text('task_id'),
  createdAt: createdAt(),
})

export const TASK_KINDS = [
  'triage',
  'prep',
  'research',
  'outreach',
  'discover',
  'funding',
  'resume-notes',
  'match',
  'submit-assist',
  'x-scout',
  'import-resume',
  'custom',
] as const
export type TaskKind = (typeof TASK_KINDS)[number]

/** Background agent jobs, executed by the job runner. */
export const tasks = sqliteTable(
  'tasks',
  {
    id: id(),
    kind: text('kind').$type<TaskKind>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed', 'cancelled'] }).notNull().default('queued'),
    priority: integer('priority').notNull().default(0),
    /** Times the job runner picked it up. A task that keeps dying with the server stops being retried. */
    attempts: integer('attempts').notNull().default(0),
    title: text('title').notNull(),
    input: json<Record<string, Json>>('input').notNull().default({}),
    output: text('output'),
    error: text('error'),
    log: text('log'),
    applicationId: text('application_id'),
    postingId: text('posting_id'),
    personId: text('person_id'),
    sessionId: text('session_id'),
    /** Which connected AI ran it, e.g. 'claude' / 'codex', and the model. */
    provider: text('provider'),
    model: text('model'),
    costUsd: real('cost_usd'),
    runAfter: text('run_after'),
    createdAt: createdAt(),
    startedAt: text('started_at'),
    finishedAt: text('finished_at'),
  },
  (t) => [index('tasks_status').on(t.status, t.priority)],
)

/** Human-readable feed of what happened, shown on Today. */
export const activity = sqliteTable(
  'activity',
  {
    id: id(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    detail: text('detail'),
    link: text('link'),
    at: text('at').notNull(),
  },
  (t) => [index('activity_at').on(t.at)],
)

export const notifications = sqliteTable('notifications', {
  id: id(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  body: text('body'),
  url: text('url'),
  priority: integer('priority').notNull().default(3),
  dedupeKey: text('dedupe_key'),
  ok: integer('ok', { mode: 'boolean' }),
  error: text('error'),
  at: text('at').notNull(),
})

export const chatThreads = sqliteTable('chat_threads', {
  id: id(),
  title: text('title').notNull(),
  sessionId: text('session_id'),
  /** The provider the session belongs to; a thread can't resume on another provider. */
  provider: text('provider'),
  model: text('model'),
  /** What page the thread was started from, e.g. { applicationId }. */
  context: json<Record<string, string>>('context'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export type ChatPart =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; input: Json; result?: string; isError?: boolean }

export const chatMessages = sqliteTable(
  'chat_messages',
  {
    id: id(),
    threadId: text('thread_id').notNull(),
    role: text('role', { enum: ['user', 'assistant'] }).notNull(),
    parts: json<ChatPart[]>('parts').notNull(),
    at: text('at').notNull(),
    /** Page the user sent it from, e.g. /applications/app_x. Lets the panel reopen a page's chats. */
    page: text('page'),
  },
  (t) => [index('chat_messages_thread').on(t.threadId, t.at), index('chat_messages_page').on(t.page)],
)

export const PROFILE_DOCS = ['experience', 'search', 'answers', 'writing', 'stories'] as const
export type ProfileDocKey = (typeof PROFILE_DOCS)[number]

/**
 * The user's own knowledge, in markdown: what they've done (the only source of facts for anything
 * an agent writes), what they're looking for, standard form answers, how they write, and stories.
 */
export const documents = sqliteTable('documents', {
  key: text('key').primaryKey(),
  body: text('body').notNull().default(''),
  updatedAt: updatedAt(),
})

/**
 * Resumes. Content is structured (see packages/shared/src/resume) and rendered by a theme; every
 * line has a stable id, which the editor, notes, the review of agent edits and the match check use.
 */
export const resumes = sqliteTable(
  'resumes',
  {
    id: id(),
    kind: text('kind', { enum: ['base', 'tailored'] }).notNull().default('base'),
    title: text('title').notNull(),
    applicationId: text('application_id'),
    /** The resume this one was tailored from. */
    baseId: text('base_id'),
    theme: text('theme').notNull().default('classic'),
    themeOptions: json<ThemeOptions>('theme_options').notNull().default({}),
    content: json<ResumeContent>('content').notNull(),
    /** The content as the user last reviewed it; lines that differ show as changes to keep or undo. */
    reviewBase: json<ResumeContent>('review_base'),
    notes: json<ResumeNote[]>('notes').notNull().default([]),
    /** Relative to the files dir. */
    pdfFile: text('pdf_file'),
    pdfPages: integer('pdf_pages'),
    pdfAt: text('pdf_at'),
    /** Bumped on every content write; the editor detects concurrent edits with it. */
    version: integer('version').notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('resumes_application').on(t.applicationId)],
)

/** Snapshots taken before overwriting resume content, so nothing is ever lost. */
export const resumeVersions = sqliteTable(
  'resume_versions',
  {
    id: id(),
    resumeId: text('resume_id').notNull(),
    content: json<ResumeContent>('content').notNull(),
    reason: text('reason'),
    at: text('at').notNull(),
  },
  (t) => [index('resume_versions_resume').on(t.resumeId, t.at)],
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: json<unknown>('value'),
})

export type Company = typeof companies.$inferSelect
export type Source = typeof sources.$inferSelect
export type Posting = typeof postings.$inferSelect
export type Application = typeof applications.$inferSelect
export type Person = typeof people.$inferSelect
export type Interaction = typeof interactions.$inferSelect
export type Draft = typeof drafts.$inferSelect
export type Research = typeof research.$inferSelect
export type Task = typeof tasks.$inferSelect
export type Activity = typeof activity.$inferSelect
export type ChatThread = typeof chatThreads.$inferSelect
export type ChatMessage = typeof chatMessages.$inferSelect
export type Document = typeof documents.$inferSelect
export type Resume = typeof resumes.$inferSelect
