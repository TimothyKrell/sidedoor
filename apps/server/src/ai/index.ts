import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { z } from 'zod'
import { config, paths } from '../config'
import { newId } from '../ids'
import { agentToken } from '../secrets'
import { getSettings, JOB_TIERS, type JobKind, type Tier } from '../settings'
import { claude } from './claude'
import { codex } from './codex'
import { grok } from './grok'
import { opencode } from './opencode'
import { type AgentResult, type AgentRun, AgentError, type Provider, type ProviderId, type ProviderStatus } from './types'

export * from './types'

export const PROVIDERS: Record<ProviderId, Provider> = { claude, codex, grok, opencode }

// ------------------------------------------------------------------------------- status

let statuses: Map<ProviderId, ProviderStatus> = new Map()
let probing: Promise<ProviderStatus[]> | null = null
let probedAt = 0
const listeners = new Set<() => void>()
export const onStatusChange = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** Probe every CLI. Cached for 5 minutes (T3 re-probes on the same interval); `force` re-probes now. */
export const providerStatuses = async (force = false): Promise<ProviderStatus[]> => {
  if (!force && statuses.size && Date.now() - probedAt < 5 * 60_000) return [...statuses.values()]
  probing ??= Promise.all(Object.values(PROVIDERS).map((p) => p.probe().catch((e): ProviderStatus => ({ id: p.id, name: p.name, installed: false, version: null, path: null, auth: 'unknown', account: null, message: String(e), models: [], install: '', login: '', docsUrl: '', checkedAt: new Date().toISOString() }))))
    .then((all) => {
      statuses = new Map(all.map((s) => [s.id, s]))
      probedAt = Date.now()
      for (const l of listeners) l()
      return all
    })
    .finally(() => {
      probing = null
    })
  return probing
}

export const cachedStatus = (id: ProviderId) => statuses.get(id)

export const readyProviders = async () => (await providerStatuses()).filter((s) => s.installed && s.auth !== 'signed-out')

// ------------------------------------------------------------------------------- routing

const TIER_MODELS: Record<ProviderId, Record<Tier, string>> = {
  claude: { fast: 'haiku', balanced: 'sonnet', best: 'opus' },
  codex: { fast: '', balanced: '', best: '' },
  grok: { fast: '', balanced: '', best: '' },
  opencode: { fast: '', balanced: '', best: '' },
}

/** Which provider and model run a kind of job. */
export const resolveJobAi = (job: JobKind, override?: { provider?: ProviderId | null; model?: string | null }) => {
  const s = getSettings().ai
  const pref = s.jobs[job]
  const provider = override?.provider ?? pref.provider ?? s.default
  if (!provider) throw new AgentError('No AI is connected yet. Open Settings → AI and connect Claude, Codex, Grok or OpenCode.')
  const model = override?.model || (pref.provider === provider || !pref.provider ? pref.model : '') || TIER_MODELS[provider][JOB_TIERS[job]]
  return { provider, model }
}

/** Sidedoor's MCP endpoint for agents we launch. `browser` adds the form-filling browser tools. */
export const mcpFor = (profile: 'app' | 'browser' | 'story' | 'lookup' = 'app') => ({
  url: `${config.localUrl}/mcp${profile === 'app' ? '' : `/${profile}`}`,
  token: agentToken(),
})

export interface JobOptions<S extends z.ZodType | undefined> extends Omit<AgentRun<S>, 'cwd' | 'model'> {
  job: JobKind
  provider?: ProviderId | null
  model?: string | null
  /** Keep the scratch directory (chat sessions resume in it). */
  cwd?: string
}

export type JobResult<T> = AgentResult<T> & { provider: ProviderId; model: string }

/**
 * Run an AI job on whichever provider the user picked for it, in a fresh empty directory.
 * Agents change user data only through Sidedoor's MCP tools, never through files.
 */
export async function runJob<S extends z.ZodType | undefined = undefined>(o: JobOptions<S>): Promise<JobResult<S extends z.ZodType ? z.infer<S> : undefined>> {
  const { provider, model } = resolveJobAi(o.job, { provider: o.provider ?? null, model: o.model ?? null })
  const own = !o.cwd
  const cwd = o.cwd ?? resolve(paths.jobs, newId('job_'))
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  try {
    const { job: _job, provider: _p, model: _m, cwd: _c, ...run } = o
    const r = await PROVIDERS[provider].run({ ...run, cwd, model })
    return { ...r, provider, model }
  } finally {
    if (own) rmSync(cwd, { recursive: true, force: true })
  }
}

export const chatCwd = (threadId: string) => {
  const dir = resolve(paths.jobs, `chat-${threadId}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}
