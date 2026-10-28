import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { config } from '../config'
import { agentToken } from '../secrets'
import { PROVIDERS } from './index'
import type { ProviderId, ProviderStatus } from './types'
import { capture } from './util'

/**
 * Register Sidedoor's MCP server in the user's own AI CLI, so their everyday sessions can read and
 * change the job search ("what's due today?", "draft a follow-up to Sarah"). Each CLI gets the
 * `sidedoor mcp` stdio bridge command; nothing in their config goes stale when the port or token
 * changes.
 */

export interface BridgeCommand {
  command: string
  args: string[]
  env: Record<string, string>
}

/** How to launch the stdio bridge on this install. The desktop app passes its own. */
export const bridgeCommand = (): BridgeCommand => {
  const fromDesktop = process.env.SIDEDOOR_MCP_COMMAND
  if (fromDesktop) return JSON.parse(fromDesktop) as BridgeCommand
  const script = process.argv[1] ?? ''
  const home: Record<string, string> = config.home !== resolve(homedir(), '.sidedoor') ? { SIDEDOOR_HOME: config.home } : {}
  return { command: process.execPath, args: [...process.execArgv.filter((a) => a !== '--watch'), script, 'mcp'], env: home }
}

const NAME = 'sidedoor'

const opencodeConfig = () => resolve(process.env.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'opencode', 'opencode.json')

const readJson = (p: string): Record<string, unknown> | null => {
  if (!existsSync(p)) return {}
  try {
    // OpenCode allows comments and trailing commas.
    return JSON.parse(readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>
  } catch {
    return null
  }
}

const binOf = async (id: ProviderId) => (await PROVIDERS[id].probe()).path

export const connectionStatus = async (statuses: ProviderStatus[]): Promise<Partial<Record<ProviderId, boolean>>> => {
  const out: Partial<Record<ProviderId, boolean>> = {}
  await Promise.all(
    statuses
      .filter((s) => s.installed && s.path)
      .map(async (s) => {
        const bin = s.path!
        if (s.id === 'claude') out.claude = (await capture(bin, ['mcp', 'get', NAME], 20_000)).code === 0
        else if (s.id === 'codex') out.codex = (await capture(bin, ['mcp', 'get', NAME], 10_000)).code === 0
        else if (s.id === 'grok') out.grok = new RegExp(`\\b${NAME}\\b`).test((await capture(bin, ['mcp', 'list'], 10_000)).out)
        else if (s.id === 'opencode') {
          const mcp = readJson(opencodeConfig())?.mcp as { servers?: Record<string, unknown> } & Record<string, unknown> | undefined
          out.opencode = !!(mcp?.servers?.[NAME] ?? mcp?.[NAME])
        }
      }),
  )
  return out
}

/**
 * `-e KEY=VALUE` pairs. They go after the server name: Claude Code's `-e` takes any number of values,
 * so before the name it would swallow the name too ("missing required argument 'commandOrUrl'").
 */
const envArgs = (flag: string, env: Record<string, string>) => Object.entries(env).flatMap(([k, v]) => [flag, `${k}=${v}`])

/** Each CLI's `mcp add` for the bridge. OpenCode's own command writes its (commented) config correctly. */
export const mcpAddArgs = (id: ProviderId, b: BridgeCommand): string[] => {
  const cmd = ['--', b.command, ...b.args]
  if (id === 'claude') return ['mcp', 'add', '-s', 'user', NAME, ...envArgs('-e', b.env), ...cmd]
  if (id === 'codex') return ['mcp', 'add', NAME, ...envArgs('--env', b.env), ...cmd]
  if (id === 'grok') return ['mcp', 'add', NAME, ...envArgs('-e', b.env), ...cmd]
  return ['mcp', 'add', NAME, '--global', ...envArgs('--env', b.env), ...cmd]
}

export const connectProvider = async (id: ProviderId) => {
  const bin = await binOf(id)
  if (!bin) throw new Error(`${PROVIDERS[id].name} is not installed.`)
  const b = bridgeCommand()
  const run = async (args: string[]) => {
    const r = await capture(bin, args, 30_000)
    if (r.code !== 0) throw new Error(`${PROVIDERS[id].name}: ${(r.err || r.out).trim().slice(0, 300) || `exit ${r.code}`}`)
  }
  if (id === 'claude') await capture(bin, ['mcp', 'remove', '-s', 'user', NAME], 20_000)
  else if (id === 'codex' || id === 'grok') await capture(bin, ['mcp', 'remove', NAME], 10_000)
  await run(mcpAddArgs(id, b))
  return { ok: true }
}

export const disconnectProvider = async (id: ProviderId) => {
  const bin = await binOf(id)
  if (!bin) return { ok: true }
  if (id === 'claude') await capture(bin, ['mcp', 'remove', '-s', 'user', NAME], 20_000)
  else if (id === 'codex' || id === 'grok') await capture(bin, ['mcp', 'remove', NAME], 10_000)
  else {
    // OpenCode has no `mcp remove`. Edit the file only when it has no comments to lose.
    const p = opencodeConfig()
    const raw = existsSync(p) ? readFileSync(p, 'utf8') : ''
    const cfg = readJson(p)
    if (/^\s*\/\//m.test(raw) || !cfg) throw new Error(`Remove the "${NAME}" entry from ${p} by hand (the file has comments Sidedoor won't overwrite).`)
    const mcp = cfg.mcp as { servers?: Record<string, unknown> } & Record<string, unknown> | undefined
    if (mcp?.servers) delete mcp.servers[NAME]
    if (mcp) delete mcp[NAME]
    writeFileSync(p, `${JSON.stringify(cfg, null, 2)}\n`)
  }
  return { ok: true }
}

/** For any other MCP client (Claude Desktop, Cursor, ChatGPT connectors over a tunnel...). */
export const connectInfo = () => {
  const b = bridgeCommand()
  return {
    stdio: { command: b.command, args: b.args, env: b.env },
    json: JSON.stringify({ mcpServers: { [NAME]: { command: b.command, args: b.args, ...(Object.keys(b.env).length ? { env: b.env } : {}) } } }, null, 2),
    http: { url: `${config.localUrl}/mcp`, header: `Authorization: Bearer ${agentToken()}` },
  }
}
