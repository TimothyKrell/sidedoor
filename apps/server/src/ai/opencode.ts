import { resolve } from 'node:path'
import type { z } from 'zod'
import { findOnPath } from '../config'
import { getSettings } from '../settings'
import { type AgentResult, type AgentRun, AgentError, type Provider, type ProviderStatus } from './types'
import { capture, childEnv, decodeJson, extractJson, firstLine, jsonSchemaOf, parseJsonLine, schemaInstructions, spawnLines, writePrivate } from './util'

/** OpenCode, headless: `opencode run --format json`. Any model the user has connected in OpenCode works. */

const bin = () => getSettings().ai.opencode.path || findOnPath('opencode') || null

const probe = async (): Promise<ProviderStatus> => {
  const path = bin()
  const base = {
    id: 'opencode' as const,
    name: 'OpenCode',
    path,
    install: process.platform === 'win32' ? 'npm install -g opencode-ai' : 'curl -fsSL https://opencode.ai/install | bash',
    login: 'opencode auth login',
    docsUrl: 'https://opencode.ai/docs',
    checkedAt: new Date().toISOString(),
  }
  if (!path) return { ...base, models: [], installed: false, version: null, auth: 'unknown', account: null, message: 'OpenCode is not installed.' }
  const v = await capture(path, ['--version'])
  if (v.code !== 0) return { ...base, models: [], installed: false, version: null, auth: 'unknown', account: null, message: firstLine(v.err) || 'Could not run opencode.' }
  const a = await capture(path, ['auth', 'list'])
  const providers = (a.out.match(/\bstored\b/g) ?? []).length
  const m = await capture(path, ['models'], 20_000)
  const models = m.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[\w.-]+\/[\w.:-]+$/.test(l))
    .slice(0, 200)
    .map((id) => ({ id, label: id }))
  return {
    ...base,
    installed: true,
    version: firstLine(v.out).replace(/^(opencode\s+)?v?/, ''),
    auth: providers > 0 ? 'ok' : 'signed-out',
    account: providers > 0 ? `${providers} model provider${providers === 1 ? '' : 's'} connected` : null,
    message: providers > 0 ? null : 'Connect a model provider in OpenCode.',
    models: [{ id: '', label: 'Default (from your OpenCode config)' }, ...models],
  }
}

const run = async <S extends z.ZodType | undefined = undefined>(r: AgentRun<S>): Promise<AgentResult<S extends z.ZodType ? z.infer<S> : undefined>> => {
  const path = bin()
  if (!path) throw new AgentError('OpenCode is not installed. Connect an AI in Settings → AI.')
  // A project config in the job's own (empty, private) folder: Sidedoor's MCP server, and no
  // shell, edits or reads outside it. OpenCode 2.x keeps MCP servers under `mcp.servers`.
  writePrivate(
    resolve(r.cwd, 'opencode.json'),
    JSON.stringify({
      $schema: 'https://opencode.ai/config.json',
      ...(r.mcp ? { mcp: { servers: { sidedoor: { type: 'remote', url: r.mcp.url, headers: { Authorization: `Bearer ${r.mcp.token}` } } } } } : {}),
      permission: { bash: 'deny', edit: 'deny', read: 'deny', external_directory: 'deny', webfetch: r.web ? 'allow' : 'deny' },
    }),
  )
  // --standalone: a private OpenCode server that reads this folder's config on the first call
  // (the shared background service misses a brand-new folder's project config).
  const args = ['run', '--standalone', '--format', 'json']
  if (r.model) args.push('-m', r.model)
  if (r.resume) args.push('-s', r.resume)
  // The prompt goes on stdin, not argv (visible in ps; length-limited on Windows).
  const prompt = `${r.system ? `${r.system}\n\n---\n\n` : ''}${r.prompt}${r.schema ? schemaInstructions(jsonSchemaOf(r.schema)) : ''}`
  const log: string[] = []
  let sessionId: string | null = r.resume ?? null
  let text = ''
  let costUsd: number | null = null
  let turns = 0
  let failure: string | null = null
  const p = spawnLines(path, args, {
    cwd: r.cwd,
    env: childEnv(),
    stdin: prompt,
    ...(r.signal ? { signal: r.signal } : {}),
    timeoutMs: r.timeoutMs ?? 30 * 60_000,
    onLine: (line) => {
      const m = parseJsonLine(line)
      if (!m) return
      if (typeof m.sessionID === 'string') sessionId = m.sessionID
      const part = m.part as { type?: string; text?: string; tool?: string; callID?: string; state?: { status?: string; input?: unknown; output?: unknown; error?: unknown }; cost?: number } | undefined
      if (m.type === 'text' && part?.text) {
        text += part.text
        log.push(part.text.slice(0, 600))
        r.onEvent?.({ type: 'text', delta: part.text })
      } else if (m.type === 'tool_use' && part) {
        const code = String((part.state?.input as { code?: string } | undefined)?.code ?? '')
        const viaCode = code.match(/tools\.sidedoor\.(\w+)/)?.[1]
        const name = viaCode ? `mcp__sidedoor__${viaCode}` : part.tool?.startsWith('sidedoor_') ? `mcp__sidedoor__${part.tool.slice(9)}` : (part.tool ?? 'tool')
        log.push(`→ ${name} ${JSON.stringify(part.state?.input ?? {}).slice(0, 240)}`)
        r.onEvent?.({ type: 'tool', id: part.callID ?? name, name, input: part.state?.input ?? {} })
        if (part.state?.status === 'completed' || part.state?.status === 'error')
          r.onEvent?.({ type: 'tool_result', id: part.callID ?? name, result: String(part.state.output ?? part.state.error ?? ''), isError: part.state.status === 'error' })
      } else if (m.type === 'step_finish') {
        turns++
        if (typeof part?.cost === 'number') costUsd = (costUsd ?? 0) + part.cost
      } else if (m.type === 'error') failure = String((m.error as { message?: string } | undefined)?.message ?? m.message ?? 'OpenCode failed')
    },
  })
  const { code, stderr } = await p.done
  if (r.signal?.aborted) throw new AgentError('Stopped.', log)
  if (failure) throw new AgentError(failure, log)
  if (code !== 0 && !text) throw new AgentError(`OpenCode exited with ${code}: ${stderr.slice(-600)}`, log)
  const data = r.schema ? decodeJson(r.schema, extractJson(text), log) : undefined
  return { text, data: data as never, sessionId, costUsd, turns, log }
}

export const opencode: Provider = { id: 'opencode', name: 'OpenCode', probe, run }
