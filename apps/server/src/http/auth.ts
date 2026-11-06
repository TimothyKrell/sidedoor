import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { config } from '../config'
import { agentToken, connectedToken, getSecret, grokBotToken, safeEqual, setSecret } from '../secrets'

/**
 * Who may talk to the server. No implicit localhost trust (T3 Code makes the same call): every
 * request carries a token, as an httpOnly cookie for browsers or a bearer header for agents.
 *
 * - The desktop app passes a per-launch token on its bootstrap and sets the cookie itself.
 * - Other browsers and phones pair with the access token (a `/pair#token=` link or QR code).
 * - Agents use the agent token on `/mcp` only. The AI the user talks to has its own, on `/mcp`
 *   alone, because only it may reach the submit tools.
 * - Grok Bot uses its own token, on `/mcp` (the app tools) only.
 */
export const COOKIE = 'sidedoor_session'

/** The pairing token for browsers and phones. Rotating it signs every paired device out. */
export const accessToken = () => {
  let t = getSecret('access-token')
  if (!t) {
    t = randomBytes(24).toString('base64url')
    setSecret('access-token', t)
  }
  return t
}
export const rotateAccessToken = () => {
  setSecret('access-token', '')
  return accessToken()
}

const readCookie = (header: string | undefined, name: string) =>
  header
    ?.split(';')
    .map((c) => c.trim().split('='))
    .find(([k]) => k === name)?.[1]

const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null
}

export const validClientToken = (t: string | null | undefined) => !!t && (safeEqual(t, config.token) || safeEqual(t, accessToken()))

/** A browser or the desktop window. */
export const isClient = (req: IncomingMessage) => validClientToken(readCookie(req.headers.cookie, COOKIE)) || validClientToken(bearer(req))

/** Which agent is calling /mcp: a background job of ours (the user's client token works too, handy for testing tools), the AI the user talks to, or Grok Bot. */
export const agentFor = (req: IncomingMessage): 'agent' | 'connected' | 'grokbot' | null => {
  const t = bearer(req)
  if (!t) return null
  if (safeEqual(t, agentToken()) || validClientToken(t)) return 'agent'
  if (safeEqual(t, connectedToken())) return 'connected'
  const g = grokBotToken()
  return g && safeEqual(t, g) ? 'grokbot' : null
}

/** The tool set a caller gets on an MCP path, or null when that isn't theirs. The token decides: a path alone never reaches the submit tools. */
export const mcpProfileFor = (agent: 'agent' | 'connected' | 'grokbot', path: string) => {
  const profile = path.slice(5) || 'app'
  if (!['app', 'browser', 'story', 'lookup'].includes(profile)) return null
  if (agent === 'agent') return profile as 'app' | 'browser' | 'story' | 'lookup'
  return profile === 'app' ? agent : null
}

/**
 * Cookie-authenticated writes must come from our own pages: a page on another origin can't send
 * the cookie (SameSite=Strict), and this blocks the rest.
 */
export const sameOrigin = (req: IncomingMessage) => {
  const origin = req.headers.origin
  if (!origin) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

export const sessionCookie = (token: string, secure: boolean) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000${secure ? '; Secure' : ''}`
