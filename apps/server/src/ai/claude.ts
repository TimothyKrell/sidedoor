import { type Options, query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { z } from 'zod'
import { findOnPath } from '../config'
import { getSettings } from '../settings'
import { type AgentResult, type AgentRun, AgentError, type Provider, type ProviderStatus } from './types'
import { capture, childEnv, decodeJson, extractJson, firstLine, jsonSchemaOf, trackAbort } from './util'

/**
 * Claude Code through the Agent SDK, driving the user's own `claude` binary and login. We never
 * bundle Claude Code: the user's install, version and subscription are what run.
 */

const bin = () => getSettings().ai.claude.path || findOnPath('claude') || null

const env = () => {
  const e = childEnv({ CLAUDE_AGENT_SDK_CLIENT_APP: 'sidedoor/0.1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_AUTO_CONNECT_IDE: '0' })
  // By default use the Claude subscription `claude` is signed in to, not a stray API key in the shell.
  if (getSettings().ai.claude.ignoreApiKey) {
    delete e.ANTHROPIC_API_KEY
    delete e.ANTHROPIC_AUTH_TOKEN
  }
  return e
}

const MODELS = [
  { id: 'opus', label: 'Opus (best writing)' },
  { id: 'sonnet', label: 'Sonnet (balanced)' },
  { id: 'haiku', label: 'Haiku (fast, cheap)' },
]

const summarize = (m: SDKMessage): string | null => {
  if (m.type === 'assistant') {
    const parts: string[] = []
    for (const b of m.message.content) {
      if (b.type === 'text' && b.text.trim()) parts.push(b.text.trim().slice(0, 600))
      if (b.type === 'tool_use') parts.push(`→ ${b.name} ${JSON.stringify(b.input).slice(0, 240)}`)
    }
    return parts.length ? parts.join('\n') : null
  }
  if (m.type === 'result') return `✓ result (${m.subtype}) turns=${m.num_turns} cost=$${m.total_cost_usd.toFixed(3)}`
  return null
}

const probe = async (): Promise<ProviderStatus> => {
  const path = bin()
  const base = {
    id: 'claude' as const,
    name: 'Claude',
    path,
    models: MODELS,
    install: process.platform === 'win32' ? 'irm https://claude.ai/install.ps1 | iex' : 'curl -fsSL https://claude.ai/install.sh | bash',
    login: 'claude auth login',
    docsUrl: 'https://docs.claude.com/en/docs/claude-code/setup',
    checkedAt: new Date().toISOString(),
  }
  if (!path) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: 'Claude is not installed (the claude command).' }
  const v = await capture(path, ['--version'])
  if (v.code !== 0) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: firstLine(v.err) || 'Could not run claude.' }
  const version = firstLine(v.out).replace(/\s*\(Claude Code\)/, '')
  // A query whose prompt never yields: Claude Code starts, reports the account, and makes no API call.
  try {
    const never = (async function* () {
      await new Promise(() => {})
    })() as AsyncIterable<never>
    // Aborting (not just interrupting) ends the claude process; otherwise each probe leaves one behind.
    const abort = new AbortController()
    const q = query({
      prompt: never,
      options: { pathToClaudeCodeExecutable: path, env: env(), persistSession: false, settings: { disableAllHooks: true } as never, allowedTools: [], mcpServers: {}, strictMcpConfig: true, settingSources: [], abortController: abort },
    })
    const init = await Promise.race([q.initializationResult(), new Promise<null>((r) => setTimeout(() => r(null), 20_000))]).finally(() => abort.abort())
    const acct = (init as { account?: { email?: string; subscriptionType?: string; tokenSource?: string; apiKeySource?: string } } | null)?.account
    if (!init) return { ...base, installed: true, version, auth: 'unknown', account: null, message: null }
    const signedIn = !!acct && (acct.tokenSource !== 'none' || !!acct.apiKeySource || !!acct.email || !!acct.subscriptionType)
    return {
      ...base,
      installed: true,
      version,
      auth: signedIn ? 'ok' : 'signed-out',
      account: [acct?.email, acct?.subscriptionType].filter(Boolean).join(' · ') || null,
      message: signedIn ? null : 'Sign in to Claude.',
    }
  } catch (e) {
    return { ...base, installed: true, version, auth: 'unknown', account: null, message: e instanceof Error ? e.message.slice(0, 200) : null }
  }
}

const run = async <S extends z.ZodType | undefined = undefined>(r: AgentRun<S>): Promise<AgentResult<S extends z.ZodType ? z.infer<S> : undefined>> => {
  const path = bin()
  if (!path) throw new AgentError('Claude is not installed (the claude command). Connect an AI in Settings → AI.')
  const tools = r.web ? ['WebSearch', 'WebFetch'] : []
  const abort = new AbortController()
  const untrack = trackAbort(abort)
  r.signal?.addEventListener('abort', () => abort.abort(), { once: true })
  const timer = r.timeoutMs ? setTimeout(() => abort.abort(), r.timeoutMs) : null
  const options: Options = {
    model: r.model || 'sonnet',
    cwd: r.cwd,
    // The MCP token travels in the environment: the SDK puts mcpServers on claude's command line,
    // which other users can read, and Claude Code expands ${VAR} in headers.
    env: { ...env(), ...(r.mcp ? { SIDEDOOR_MCP_TOKEN: r.mcp.token } : {}) },
    pathToClaudeCodeExecutable: path,
    tools,
    allowedTools: [...tools, ...(r.mcp ? ['mcp__sidedoor__*'] : [])],
    permissionMode: 'dontAsk',
    // Isolated from the user's own hooks, CLAUDE.md files and MCP servers: the job brings its own.
    settingSources: [],
    strictMcpConfig: true,
    persistSession: !!r.resume || !!r.onEvent,
    ...(r.mcp ? { mcpServers: { sidedoor: { type: 'http', url: r.mcp.url, headers: { Authorization: 'Bearer ${SIDEDOOR_MCP_TOKEN}' } } } } : {}),
    ...(r.system ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: r.system } } : {}),
    ...(r.maxTurns ? { maxTurns: r.maxTurns } : {}),
    ...(r.schema ? { outputFormat: { type: 'json_schema', schema: jsonSchemaOf(r.schema) } } : {}),
    ...(r.resume ? { resume: r.resume } : {}),
    ...(r.onEvent ? { includePartialMessages: true } : {}),
    abortController: abort,
  }
  const log: string[] = []
  let sessionId: string | null = r.resume ?? null
  let text = ''
  let structured: unknown
  let costUsd: number | null = null
  let turns = 0
  let failure: string | null = null
  try {
    for await (const m of query({ prompt: r.prompt, options })) {
      if ('session_id' in m && typeof m.session_id === 'string') sessionId = m.session_id
      const line = summarize(m)
      if (line) log.push(line)
      if (r.onEvent) {
        if (m.type === 'stream_event' && m.parent_tool_use_id === null) {
          const ev = m.event
          if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') r.onEvent({ type: 'text', delta: ev.delta.text })
        } else if (m.type === 'assistant' && m.parent_tool_use_id === null) {
          for (const b of m.message.content) if (b.type === 'tool_use') r.onEvent({ type: 'tool', id: b.id, name: b.name, input: b.input })
        } else if (m.type === 'user' && m.parent_tool_use_id === null && Array.isArray(m.message.content)) {
          for (const b of m.message.content) {
            if (typeof b === 'object' && b.type === 'tool_result') {
              const raw = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((c) => ('text' in c ? c.text : '')).join('\n') : ''
              r.onEvent({ type: 'tool_result', id: b.tool_use_id, result: raw, isError: b.is_error === true })
            }
          }
        }
      }
      if (m.type === 'result') {
        costUsd = m.total_cost_usd
        turns = m.num_turns
        if (m.subtype === 'success' && !m.is_error) {
          text = m.result
          structured = m.structured_output
        } else failure = m.subtype === 'success' ? m.result : `${m.subtype}: ${m.errors.join('; ')}`
      }
    }
  } catch (e) {
    throw new AgentError(abort.signal.aborted ? (r.signal?.aborted ? 'Stopped.' : 'Timed out.') : e instanceof Error ? e.message : String(e), log)
  } finally {
    if (timer) clearTimeout(timer)
    untrack()
  }
  if (failure) throw new AgentError(failure, log)
  const data = r.schema ? decodeJson(r.schema, structured ?? extractJson(text), log) : undefined
  return { text, data: data as never, sessionId, costUsd, turns, log }
}

export const claude: Provider = { id: 'claude', name: 'Claude', probe, run }
