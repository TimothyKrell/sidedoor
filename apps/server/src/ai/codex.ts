import { resolve } from 'node:path'
import type { z } from 'zod'
import { findOnPath } from '../config'
import { getSettings } from '../settings'
import { type AgentResult, type AgentRun, AgentError, type Provider, type ProviderStatus } from './types'
import { capture, childEnv, decodeJson, extractJson, firstLine, jsonSchemaOf, parseJsonLine, spawnLines, strictSchema, writePrivate } from './util'

/** OpenAI Codex CLI, headless: `codex exec --json`, sessions resumable with `exec resume`. */

const bin = () => getSettings().ai.codex.path || findOnPath('codex') || null

const tomlString = (s: string) => JSON.stringify(s)

const probe = async (): Promise<ProviderStatus> => {
  const path = bin()
  const base = {
    id: 'codex' as const,
    name: 'Codex',
    path,
    models: [
      { id: '', label: 'Default (from your Codex config)' },
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini' },
    ],
    install: 'npm install -g @openai/codex',
    login: 'codex login',
    docsUrl: 'https://developers.openai.com/codex/cli',
    checkedAt: new Date().toISOString(),
  }
  if (!path) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: 'Codex is not installed.' }
  const v = await capture(path, ['--version'])
  if (v.code !== 0) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: firstLine(v.err) || 'Could not run codex.' }
  const s = await capture(path, ['login', 'status'])
  const out = `${s.out}\n${s.err}`
  const ok = /logged in/i.test(out) && !/not logged in/i.test(out)
  return {
    ...base,
    installed: true,
    version: firstLine(v.out).replace(/^codex-cli\s*/, ''),
    auth: ok ? 'ok' : 'signed-out',
    account: ok ? firstLine(out).replace(/^Logged in using\s*/i, '') : null,
    message: ok ? null : 'Sign in to Codex.',
  }
}

const run = async <S extends z.ZodType | undefined = undefined>(r: AgentRun<S>): Promise<AgentResult<S extends z.ZodType ? z.infer<S> : undefined>> => {
  const path = bin()
  if (!path) throw new AgentError('Codex is not installed. Connect an AI in Settings → AI.')
  const args = r.resume ? ['exec', 'resume', r.resume] : ['exec']
  args.push('--json', '--skip-git-repo-check', '-C', r.cwd, '-s', 'read-only')
  if (!r.resume && !r.onEvent) args.push('--ephemeral')
  if (r.model) args.push('-m', r.model)
  // Leave the user's own plugins out of Sidedoor jobs, and give the agent no shell: it works
  // through Sidedoor's tools and web search only, so a job posting can't talk it into reading files.
  args.push('-c', 'features.plugins=false', '-c', 'features.apps=false', '--disable', 'shell_tool', '--disable', 'unified_exec', '--disable', 'browser_use')
  if (r.mcp) {
    args.push('-c', `mcp_servers.sidedoor.url=${tomlString(r.mcp.url)}`)
    // The token goes through the environment, not argv (argv is visible to other users in ps).
    args.push('-c', 'mcp_servers.sidedoor.bearer_token_env_var="SIDEDOOR_MCP_TOKEN"')
    args.push('-c', 'mcp_servers.sidedoor.tool_timeout_sec=600')
  }
  args.push('-c', `web_search=${r.web ? '"live"' : '"disabled"'}`)
  if (r.schema && !r.resume) {
    const file = resolve(r.cwd, 'output-schema.json')
    writePrivate(file, JSON.stringify(strictSchema(jsonSchemaOf(r.schema))))
    args.push('--output-schema', file)
  }
  args.push('-')
  const prompt = r.system ? `${r.system}\n\n---\n\n${r.prompt}` : r.prompt
  const log: string[] = []
  let sessionId: string | null = r.resume ?? null
  let last = ''
  let turns = 0
  let failure: string | null = null
  const p = spawnLines(path, args, {
    cwd: r.cwd,
    env: childEnv(r.mcp ? { SIDEDOOR_MCP_TOKEN: r.mcp.token } : {}),
    stdin: prompt,
    ...(r.signal ? { signal: r.signal } : {}),
    timeoutMs: r.timeoutMs ?? 30 * 60_000,
    onLine: (line) => {
      const m = parseJsonLine(line)
      if (!m) return
      if (m.type === 'thread.started' && typeof m.thread_id === 'string') sessionId = m.thread_id
      if (m.type === 'turn.completed') turns++
      if (m.type === 'turn.failed' || m.type === 'error') failure = String((m.error as { message?: string } | undefined)?.message ?? m.message ?? 'Codex failed')
      const item = m.item as { id?: string; type?: string; text?: string; server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown; status?: string; query?: string } | undefined
      if (!item) return
      if (m.type === 'item.started' && item.type === 'mcp_tool_call') {
        const name = `mcp__${item.server}__${item.tool}`
        log.push(`→ ${name} ${JSON.stringify(item.arguments ?? {}).slice(0, 240)}`)
        r.onEvent?.({ type: 'tool', id: item.id ?? name, name, input: item.arguments ?? {} })
      }
      if (m.type !== 'item.completed') return
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        last = item.text
        log.push(item.text.slice(0, 600))
        r.onEvent?.({ type: 'text', delta: `${item.text}\n\n` })
      } else if (item.type === 'mcp_tool_call') {
        const res = typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? item.error ?? '')
        r.onEvent?.({ type: 'tool_result', id: item.id ?? '', result: res, isError: item.status === 'failed' || !!item.error })
      } else if (item.type === 'web_search') {
        log.push(`→ web_search ${item.query ?? ''}`)
        r.onEvent?.({ type: 'tool', id: item.id ?? 'ws', name: 'WebSearch', input: { query: item.query } })
      }
    },
  })
  const { code, stderr } = await p.done
  if (r.signal?.aborted) throw new AgentError('Stopped.', log)
  if (failure) throw new AgentError(failure, log)
  if (code !== 0 && !last) throw new AgentError(`Codex exited with ${code}: ${stderr.slice(-600)}`, log)
  const data = r.schema ? decodeJson(r.schema, extractJson(last), log) : undefined
  return { text: last, data: data as never, sessionId, costUsd: null, turns, log }
}

export const codex: Provider = { id: 'codex', name: 'Codex', probe, run }
