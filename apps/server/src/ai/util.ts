import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { AgentError } from './types'

/**
 * Environment for agent subprocesses: the user's environment minus anything that would point an
 * agent at this server's internals or make it think it's nested inside another agent.
 */
export const childEnv = (extra: Record<string, string> = {}) => {
  const e: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (k.startsWith('SIDEDOOR_') || k === 'ELECTRON_RUN_AS_NODE' || k === 'CLAUDECODE' || k.startsWith('CLAUDE_CODE_ENTRYPOINT')) continue
    e[k] = v
  }
  return { ...e, ...extra }
}

export interface Spawned {
  /** Resolves with the exit code once the process ends. */
  done: Promise<{ code: number | null; stderr: string }>
  kill: () => void
}

/**
 * How to start a CLI without a shell. On Windows, npm installs CLIs as `.cmd` shims, and running
 * those means cmd.exe re-parsing every argument (prompts included: `&`, `|`, `%` and newlines
 * would run commands). The shim just runs `node <script>`, so we run that directly.
 */
export const resolveCommand = (cmd: string): { command: string; prefix: string[] } => {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(cmd)) return { command: cmd, prefix: [] }
  let text = ''
  try {
    text = readFileSync(cmd, 'utf8')
  } catch {
    // fall through to the error below
  }
  const script = text.match(/"%(?:~)?dp0%\\?([^"]+\.(?:c?js|mjs))"/i)?.[1]
  if (!script) throw new AgentError(`Can't run ${cmd} safely (not a standard npm shim). Set the path to the program itself in Settings → AI.`)
  const dir = dirname(cmd)
  const localNode = resolve(dir, 'node.exe')
  return { command: existsSync(localNode) ? localNode : 'node', prefix: [resolve(dir, script)] }
}

/** Every agent process we started and haven't seen exit, so shutdown can stop them. */
const live = new Set<ChildProcess>()

/** Stop a process and everything it started (CLIs spawn their own helpers). */
const killTree = (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, signal)
  } catch {
    child.kill(signal)
  }
}

/** Called on server shutdown: no agent outlives the server (it would run again on next start). */
/** Agent SDK runs (Claude) whose process the SDK owns: stopped by aborting. */
const liveAborts = new Set<AbortController>()
export const trackAbort = (a: AbortController) => {
  liveAborts.add(a)
  return () => liveAborts.delete(a)
}

export const killAllAgents = () => {
  for (const c of live) killTree(c, 'SIGKILL')
  live.clear()
  for (const a of liveAborts) a.abort()
  liveAborts.clear()
}

/** Run a CLI, feeding stdin and handing each stdout line to `onLine`. */
export const spawnLines = (
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string; onLine: (line: string) => void; signal?: AbortSignal; timeoutMs?: number },
): Spawned => {
  const r = resolveCommand(cmd)
  // Own process group on POSIX, so killing it reaches the CLI's children too.
  // PWD too: some CLIs (OpenCode) find their project from $PWD, not the process's working directory.
  const env = { ...(opts.env ?? childEnv()), PWD: opts.cwd }
  const child = spawn(r.command, [...r.prefix, ...args], { cwd: opts.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' })
  live.add(child)
  let stderr = ''
  child.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-8000)
  })
  createInterface({ input: child.stdout }).on('line', opts.onLine)
  // A CLI that exits before reading its input (bad flag, signed out) must not crash the server.
  child.stdin.on('error', () => {})
  child.stdin.end(opts.stdin ?? '')
  const kill = () => {
    killTree(child, 'SIGTERM')
    setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref()
  }
  opts.signal?.addEventListener('abort', kill, { once: true })
  const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : null
  const done = new Promise<{ code: number | null; stderr: string }>((ok, fail) => {
    child.on('error', (e) => {
      live.delete(child)
      fail(new AgentError(`${cmd}: ${e.message}`))
    })
    child.on('close', (code) => {
      live.delete(child)
      if (timer) clearTimeout(timer)
      ok({ code, stderr })
    })
  })
  return { done, kill }
}

/** Run a short command and collect its output (probes). */
export const capture = (cmd: string, args: string[], timeoutMs = 15_000) =>
  new Promise<{ code: number | null; out: string; err: string }>((ok) => {
    let out = ''
    let err = ''
    try {
      const r = resolveCommand(cmd)
      const child = spawn(r.command, [...r.prefix, ...args], { env: childEnv({ NO_COLOR: '1', GROK_DISABLE_AUTOUPDATER: '1' }), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
      child.stdout.on('data', (d: Buffer) => (out += d.toString()))
      child.stderr.on('data', (d: Buffer) => (err += d.toString()))
      child.on('error', (e) => {
        clearTimeout(t)
        ok({ code: -1, out, err: e.message })
      })
      child.on('close', (code) => {
        clearTimeout(t)
        ok({ code, out, err })
      })
    } catch (e) {
      ok({ code: -1, out, err: e instanceof Error ? e.message : String(e) })
    }
  })

/** Write a file only this user can read (prompts and configs can hold personal data or tokens). */
export const writePrivate = (path: string, content: string) => {
  writeFileSync(path, content, { mode: 0o600 })
}

export const parseJsonLine = (line: string): Record<string, unknown> | null => {
  const t = line.trim()
  if (!t.startsWith('{')) return null
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
}

/** Pull the first JSON value out of prose (for providers without native schema enforcement). */
export const extractJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const cand = fenced?.[1] ?? text
  for (const [o, c] of [
    ['{', '}'],
    ['[', ']'],
  ] as const) {
    const a = cand.indexOf(o)
    const b = cand.lastIndexOf(c)
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(cand.slice(a, b + 1))
      } catch {
        // try the next shape
      }
    }
  }
  return undefined
}

const dropNulls = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(dropNulls)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, dropNulls(x)]))
  return v
}

/** Validate a provider's JSON against the job's schema. Strict-mode providers send null for omitted keys. */
export const decodeJson = <S extends z.ZodType>(schema: S, candidate: unknown, log: string[]): z.infer<S> => {
  const first = schema.safeParse(candidate)
  if (first.success) return first.data
  const second = schema.safeParse(dropNulls(candidate))
  if (second.success) return second.data
  throw new AgentError(`The AI returned JSON that doesn't match what this job needs: ${first.error.message.slice(0, 400)}`, log)
}

export const jsonSchemaOf = (schema: z.ZodType) => z.toJSONSchema(schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>

/**
 * OpenAI strict structured outputs (Codex): every object closed, every key required, optional
 * keys nullable instead.
 */
export const strictSchema = (s: Record<string, unknown>): Record<string, unknown> => {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk)
    if (!n || typeof n !== 'object') return n
    const o = { ...(n as Record<string, unknown>) }
    delete o.default
    delete o.$schema
    if (o.type === 'object' && o.properties && typeof o.properties === 'object') {
      const props = o.properties as Record<string, unknown>
      const req = new Set((o.required as string[] | undefined) ?? [])
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(props)) {
        const w = walk(v) as Record<string, unknown>
        next[k] = req.has(k) ? w : { anyOf: [w, { type: 'null' }] }
      }
      o.properties = next
      o.required = Object.keys(next)
      o.additionalProperties = false
    }
    for (const k of ['items', 'anyOf', 'oneOf', 'allOf']) if (o[k]) o[k] = walk(o[k])
    return o
  }
  return walk(s) as Record<string, unknown>
}

export const schemaInstructions = (schema: Record<string, unknown>) =>
  `\n\nWhen you are done, reply with only a JSON value (no prose, no code fence) matching this JSON Schema:\n${JSON.stringify(schema)}`

export const firstLine = (s: string) => s.trim().split('\n')[0]?.trim() ?? ''
