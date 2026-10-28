import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import type { z } from 'zod'
import { findOnPath } from '../config'
import { getSettings } from '../settings'
import { type AgentResult, type AgentRun, AgentError, type Provider, type ProviderStatus } from './types'
import { capture, childEnv, decodeJson, extractJson, firstLine, jsonSchemaOf, parseJsonLine, spawnLines, writePrivate } from './util'

/**
 * xAI's Grok Build CLI, headless (`grok -p`). Grok's own tools include live search over the web
 * and X, which is why Sidedoor sends X research jobs here when it's connected.
 */

const bin = () => getSettings().ai.grok.path || findOnPath('grok') || null

const probe = async (): Promise<ProviderStatus> => {
  const path = bin()
  const base = {
    id: 'grok' as const,
    name: 'Grok Build',
    path,
    models: [{ id: '', label: 'Default' }],
    install: 'npm install -g @xai-official/grok',
    login: 'grok login',
    docsUrl: 'https://x.ai/cli',
    checkedAt: new Date().toISOString(),
  }
  if (!path) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: 'Grok Build is not installed.' }
  const v = await capture(path, ['--version'], 8000)
  if (v.code !== 0) return { ...base, installed: false, version: null, auth: 'unknown', account: null, message: firstLine(v.err) || 'Could not run grok.' }
  const m = await capture(path, ['models'], 15_000)
  const out = `${m.out}\n${m.err}`
  const models = [...out.matchAll(/^\s*[*-]\s+([\w.-]+)/gm)].map((x) => ({ id: x[1]!, label: x[1]! }))
  const signedOut = /not authenticated|not logged in/i.test(out)
  const hasKey = !!process.env.XAI_API_KEY
  return {
    ...base,
    installed: true,
    version: firstLine(v.out).replace(/^grok\s*/, '').split(' ')[0] ?? null,
    auth: signedOut && !hasKey ? 'signed-out' : 'ok',
    account: hasKey ? 'xAI API key' : null,
    message: signedOut && !hasKey ? 'Sign in to Grok.' : null,
    models: [{ id: '', label: 'Default' }, ...models],
  }
}

const run = async <S extends z.ZodType | undefined = undefined>(r: AgentRun<S>): Promise<AgentResult<S extends z.ZodType ? z.infer<S> : undefined>> => {
  const path = bin()
  if (!path) throw new AgentError('Grok Build is not installed. Connect an AI in Settings → AI.')
  // Sidedoor's MCP server goes in a project config inside the job's own directory.
  if (r.mcp) {
    mkdirSync(resolve(r.cwd, '.grok'), { recursive: true })
    writePrivate(
      resolve(r.cwd, '.grok/config.toml'),
      `[mcp_servers.sidedoor]\ntransport = "http"\nurl = ${JSON.stringify(r.mcp.url)}\nheaders = { Authorization = ${JSON.stringify(`Bearer ${r.mcp.token}`)} }\n`,
    )
  }
  // The prompt goes in a private file, not argv: argv is visible in ps, and on Windows it's
  // length-limited.
  const promptFile = resolve(r.cwd, '.sidedoor-prompt.md')
  writePrivate(promptFile, r.system ? `${r.system}\n\n---\n\n${r.prompt}` : r.prompt)
  const args = ['--prompt-file', promptFile, '--output-format', 'streaming-json', '--cwd', r.cwd, '--permission-mode', 'dontAsk', '--no-plan']
  if (r.model) args.push('-m', r.model)
  if (r.resume) args.push('-r', r.resume)
  if (r.maxTurns) args.push('--max-turns', String(r.maxTurns))
  if (!r.web) args.push('--disable-web-search')
  if (r.mcp) args.push('--allow', 'mcp__sidedoor__*')
  if (r.schema) args.push('--json-schema', JSON.stringify(jsonSchemaOf(r.schema)))
  if (r.onEvent) args.push('--include-partial-messages')
  const log: string[] = []
  let sessionId: string | null = r.resume ?? null
  let text = ''
  let result = ''
  let structured: unknown
  let turns = 0
  let failure: string | null = null
  const p = spawnLines(path, args, {
    cwd: r.cwd,
    env: childEnv({ GROK_DISABLE_AUTOUPDATER: '1' }),
    ...(r.signal ? { signal: r.signal } : {}),
    timeoutMs: r.timeoutMs ?? 30 * 60_000,
    onLine: (line) => {
      const m = parseJsonLine(line)
      if (!m) return
      const sid = m.session_id ?? m.sessionId
      if (typeof sid === 'string') sessionId = sid
      // Claude-Code-compatible stream shape, which Grok Build mirrors.
      if (m.type === 'assistant' && m.message && typeof m.message === 'object') {
        for (const b of ((m.message as { content?: unknown[] }).content ?? []) as Array<Record<string, unknown>>) {
          if (b.type === 'text' && typeof b.text === 'string') {
            text += b.text
            log.push(b.text.slice(0, 600))
            if (!r.onEvent) continue
          }
          if (b.type === 'tool_use') {
            log.push(`→ ${String(b.name)} ${JSON.stringify(b.input ?? {}).slice(0, 240)}`)
            r.onEvent?.({ type: 'tool', id: String(b.id), name: String(b.name), input: b.input ?? {} })
          }
        }
      } else if (m.type === 'stream_event') {
        const ev = m.event as { type?: string; delta?: { type?: string; text?: string } } | undefined
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) r.onEvent?.({ type: 'text', delta: ev.delta.text })
      } else if (m.type === 'text_delta' || m.type === 'delta') {
        const d = String(m.text ?? m.delta ?? '')
        text += d
        r.onEvent?.({ type: 'text', delta: d })
      } else if (m.type === 'result') {
        turns = Number(m.num_turns ?? 1)
        if (m.is_error || (typeof m.subtype === 'string' && m.subtype !== 'success')) failure = String(m.result ?? m.error ?? m.subtype)
        else {
          result = typeof m.result === 'string' ? m.result : text
          structured = m.structured_output
        }
      }
    },
  })
  const { code, stderr } = await p.done
  if (r.signal?.aborted) throw new AgentError('Stopped.', log)
  if (failure) throw new AgentError(failure, log)
  const final = result || text
  if (code !== 0 && !final) throw new AgentError(`Grok exited with ${code}: ${stderr.slice(-600)}`, log)
  const data = r.schema ? decodeJson(r.schema, structured ?? extractJson(final), log) : undefined
  return { text: final, data: data as never, sessionId, costUsd: null, turns, log }
}

export const grok: Provider = { id: 'grok', name: 'Grok Build', probe, run }
