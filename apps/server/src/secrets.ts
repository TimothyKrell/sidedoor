import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { paths } from './config'

/**
 * Secrets live one per file in userdata/secrets (0600), never in the settings table, and are never
 * sent to clients (T3 Code stores its secrets the same way).
 */
export const SECRET_NAMES = ['agent-token', 'access-token', 'hunter-api-key', 'ntfy-token', 'grokbot-token', 'grokbot-webhook-key'] as const
export type SecretName = (typeof SECRET_NAMES)[number]

const file = (name: SecretName) => resolve(paths.secrets, `${name}.bin`)

export const getSecret = (name: SecretName): string => {
  const f = file(name)
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : ''
}

export const setSecret = (name: SecretName, value: string) => {
  const f = file(name)
  if (!value) {
    rmSync(f, { force: true })
    return
  }
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, value, { mode: 0o600 })
  renameSync(tmp, f)
  try {
    chmodSync(f, 0o600)
  } catch {
    // Windows: ACLs, not modes.
  }
}

export const hasSecret = (name: SecretName) => getSecret(name) !== ''

/**
 * The token agents present to Sidedoor's MCP endpoint: agents Sidedoor launches, and the user's
 * own Claude Code / Codex / Grok / OpenCode once connected. Rotating it disconnects all of them.
 */
export const agentToken = () => {
  let t = getSecret('agent-token')
  if (!t) {
    t = `sd_${randomBytes(24).toString('base64url')}`
    setSecret('agent-token', t)
  }
  return t
}

export const rotateAgentToken = () => {
  setSecret('agent-token', '')
  return agentToken()
}

/**
 * Grok Bot's own token for `/mcp`. Its Bots run on a cloud computer and reach Sidedoor at a public
 * address, so it gets a token of its own that can be revoked without disconnecting anything else.
 * Empty until the user turns Grok Bot on.
 */
export const grokBotToken = (create = false) => {
  let t = getSecret('grokbot-token')
  if (!t && create) {
    t = `sdg_${randomBytes(24).toString('base64url')}`
    setSecret('grokbot-token', t)
  }
  return t
}

export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}
