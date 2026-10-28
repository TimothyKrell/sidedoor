import type { z } from 'zod'

export const PROVIDER_IDS = ['claude', 'codex', 'grok', 'opencode'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

export interface ModelInfo {
  id: string
  label: string
}

export interface ProviderStatus {
  id: ProviderId
  name: string
  installed: boolean
  version: string | null
  path: string | null
  auth: 'ok' | 'signed-out' | 'unknown'
  /** Who is signed in, when the CLI tells us ("you@example.com · Max"). */
  account: string | null
  /** What to do next when not ready, e.g. "Run `claude auth login`". */
  message: string | null
  models: ModelInfo[]
  /** The command that installs it, and the one that signs in. */
  install: string
  login: string
  docsUrl: string
  checkedAt: string
}

/** Sidedoor's MCP endpoint for one run. */
export interface McpAccess {
  url: string
  token: string
}

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; result: string; isError: boolean }

export interface AgentRun<S extends z.ZodType | undefined = undefined> {
  prompt: string
  /** Extra system instructions, appended to the provider's own. */
  system?: string
  model?: string | null
  /** When given, the final answer must be JSON matching it; parsed into `data`. */
  schema?: S
  /** Allow the provider's own web search / fetch tools. */
  web?: boolean
  /** Sidedoor's tools. Omit for pure text/JSON jobs. */
  mcp?: McpAccess
  /** Empty scratch directory the agent runs in. */
  cwd: string
  maxTurns?: number
  /** Continue a provider session (chat). */
  resume?: string | null
  signal?: AbortSignal
  timeoutMs?: number
  onEvent?: (e: AgentEvent) => void
}

export interface AgentResult<T> {
  text: string
  data: T
  sessionId: string | null
  costUsd: number | null
  turns: number
  /** Compact transcript for task logs. */
  log: string[]
}

export interface Provider {
  id: ProviderId
  name: string
  probe(): Promise<ProviderStatus>
  run<S extends z.ZodType | undefined = undefined>(r: AgentRun<S>): Promise<AgentResult<S extends z.ZodType ? z.infer<S> : undefined>>
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly log: string[] = [],
  ) {
    super(message)
  }
}
