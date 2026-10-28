import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db, schema } from './db/client'
import { PROVIDER_IDS } from './ai/types'

const provider = z.enum(PROVIDER_IDS)

/** Which AI runs a kind of job. Empty provider = the default AI; empty model = that AI's choice for the job's tier. */
const jobAi = z
  .object({
    provider: provider.nullable().default(null),
    model: z.string().default(''),
  })
  .prefault({})

export const JOB_TIERS = {
  triage: 'balanced',
  prep: 'best',
  research: 'balanced',
  outreach: 'best',
  discover: 'balanced',
  funding: 'balanced',
  chat: 'best',
  editor: 'best',
  match: 'balanced',
  fill: 'balanced',
  x: 'balanced',
  import: 'balanced',
} as const
export type JobKind = keyof typeof JOB_TIERS
export type Tier = 'fast' | 'balanced' | 'best'

export const WORK_MODES = ['remote', 'hybrid', 'onsite'] as const

export const AppSettings = z.object({
  /** First-run flow. Null until the user finishes or skips it. */
  onboarding: z
    .object({
      completedAt: z.string().nullable().default(null),
      step: z.string().default('welcome'),
    })
    .prefault({}),
  /** Who the user is. Prompts and drafts use these; the resume holds the full version. */
  you: z
    .object({
      name: z.string().default(''),
      email: z.string().default(''),
      phone: z.string().default(''),
      location: z.string().default(''),
      /** ISO country of residence, e.g. "US". Drives the location filter. */
      country: z.string().default(''),
      links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
    })
    .prefault({}),
  /** What they're looking for, as structured choices. The search document holds the nuance. */
  search: z
    .object({
      roles: z.array(z.string()).default([]),
      seniority: z.array(z.string()).default([]),
      workModes: z.array(z.enum(WORK_MODES)).default(['remote']),
      /** Places they can work from or commute to, e.g. ["United States", "New York"]. */
      locations: z.array(z.string()).default([]),
      salaryMin: z.number().nullable().default(null),
      currency: z.string().default('USD'),
      /** Industries / domains ("fintech", "AI", "climate"). Called "lanes" in triage. */
      lanes: z.array(z.string()).default([]),
      dealbreakers: z.array(z.string()).default([]),
    })
    .prefault({}),
  scout: z
    .object({
      enabled: z.boolean().default(true),
      /** Minutes between polls of "hot" sources (dream companies). */
      hotIntervalMin: z.number().min(1).default(5),
      normalIntervalMin: z.number().min(2).default(20),
      maxAgeDays: z.number().default(30),
      /** Title regexes. Generated from search.roles; editable under Advanced. */
      titleInclude: z.array(z.string()).default([]),
      titleExclude: z.array(z.string()).default([]),
      /** Location regexes. Generated from search.locations / country. */
      locationOk: z.string().default(''),
      remoteWords: z.string().default('remote|distributed|anywhere'),
      locationBlock: z.string().default(''),
    })
    .prefault({}),
  triage: z
    .object({
      enabled: z.boolean().default(true),
      batchSize: z.number().min(1).max(20).default(8),
      maxPerRun: z.number().default(64),
      minFitScore: z.number().default(70),
      maybeFitScore: z.number().default(55),
    })
    .prefault({}),
  prep: z
    .object({
      /** Automatically build application packages for strong fits. */
      auto: z.boolean().default(false),
      maxAwaitingReview: z.number().default(10),
      maxPages: z.number().min(1).max(3).default(2),
    })
    .prefault({}),
  research: z
    .object({
      /** Automatically research the company + find people when a job is tracked. */
      auto: z.boolean().default(false),
    })
    .prefault({}),
  funding: z
    .object({
      enabled: z.boolean().default(false),
      intervalHours: z.number().default(12),
    })
    .prefault({}),
  discover: z
    .object({
      enabled: z.boolean().default(true),
      /** Local hour of the daily discovery run. */
      hour: z.number().min(0).max(23).default(6),
    })
    .prefault({}),
  notify: z
    .object({
      /** Native desktop notifications (desktop app). */
      desktop: z.boolean().default(true),
      /** Phone push through ntfy (optional). */
      ntfyEnabled: z.boolean().default(false),
      ntfyServer: z.string().default('https://ntfy.sh'),
      ntfyTopic: z.string().default(''),
      /** Notify right away when a fresh posting scores at least this. */
      hotFitScore: z.number().default(80),
      /** ...and was posted within this many hours. */
      hotMaxAgeHours: z.number().default(48),
      digest: z.boolean().default(true),
      digestHour: z.number().min(0).max(23).default(8),
      quietStart: z.number().min(0).max(23).default(22),
      quietEnd: z.number().min(0).max(23).default(7),
    })
    .prefault({}),
  followups: z
    .object({
      defaultCadenceDays: z.number().default(7),
      afterApplyDays: z.number().default(7),
    })
    .prefault({}),
  editor: z
    .object({
      /** A second, separate AI pass that lightly edits drafts against the writing rules. */
      enabled: z.boolean().default(true),
    })
    .prefault({}),
  worker: z
    .object({
      /** AI jobs that may run at once. Keeps subscription usage sane. */
      concurrency: z.number().min(1).max(6).default(2),
      paused: z.boolean().default(false),
    })
    .prefault({}),
  ai: z
    .object({
      /** The AI everything uses unless a job says otherwise. Chosen during onboarding. */
      default: provider.nullable().default(null),
      jobs: z
        .object(Object.fromEntries(Object.keys(JOB_TIERS).map((k) => [k, jobAi])) as Record<JobKind, typeof jobAi>)
        .prefault({}),
      claude: z.object({ path: z.string().default(''), ignoreApiKey: z.boolean().default(true) }).prefault({}),
      codex: z.object({ path: z.string().default('') }).prefault({}),
      grok: z.object({ path: z.string().default('') }).prefault({}),
      opencode: z.object({ path: z.string().default('') }).prefault({}),
    })
    .prefault({}),
  /**
   * xAI's Grok Bot, an agent that runs on a cloud computer: it reaches Sidedoor's MCP endpoint at a
   * public address, and takes the jobs sent to it from a queue (a routine webhook wakes it).
   */
  grokBot: z
    .object({
      /** The public address Grok Bot reaches Sidedoor at, e.g. a Tailscale Funnel URL. */
      publicUrl: z.string().default(''),
      /** The POST URL of the Grok Bot routine that takes Sidedoor's tasks. Its key is a secret. */
      webhookUrl: z.string().default(''),
      /** Send company research to Grok Bot instead of running it here. */
      research: z.boolean().default(false),
      /** Send research on X to Grok Bot. */
      x: z.boolean().default(false),
    })
    .prefault({}),
  app: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
      /** Keep running in the tray when the window closes (desktop). */
      runInBackground: z.boolean().default(true),
      launchAtLogin: z.boolean().default(false),
      /** Listen on the local network so a phone can connect (requires the pairing token). */
      allowNetwork: z.boolean().default(false),
      /** Base URL that links in phone notifications point to, e.g. a Tailscale name. */
      publicUrl: z.string().default(''),
    })
    .prefault({}),
})
export type AppSettings = z.infer<typeof AppSettings>
export type AppSettingsInput = z.input<typeof AppSettings>

const KEY = 'app'

let cache: { at: number; value: AppSettings } | null = null

export const getSettings = (): AppSettings => {
  // Settings are read on every job tick; a short cache keeps that off the database.
  if (cache && Date.now() - cache.at < 1000) return cache.value
  const row = db.select().from(schema.settings).where(eq(schema.settings.key, KEY)).get()
  const parsed = AppSettings.safeParse(row?.value ?? {})
  const value = parsed.success ? parsed.data : AppSettings.parse({})
  cache = { at: Date.now(), value }
  return value
}

export const saveSettings = (value: AppSettingsInput) => {
  const v = AppSettings.parse(value)
  db.insert(schema.settings)
    .values({ key: KEY, value: v })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value: v } })
    .run()
  cache = null
  return v
}

/** Shallow-merge one section. */
export const updateSettings = <K extends keyof AppSettings>(section: K, patch: Partial<AppSettings[K]>) => {
  const s = getSettings()
  return saveSettings({ ...s, [section]: { ...s[section], ...patch } })
}

/** Small key/value store for job bookkeeping (last run times). */
export const getMeta = <T>(key: string): T | undefined =>
  db.select().from(schema.settings).where(eq(schema.settings.key, `meta:${key}`)).get()?.value as T | undefined

export const setMeta = (key: string, value: unknown) =>
  db.insert(schema.settings)
    .values({ key: `meta:${key}`, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run()
