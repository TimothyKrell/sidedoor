import { FORM_OPEN_SERVER_MS } from '@sidedoor/shared/form-window'
import { config } from '../config'

/**
 * The desktop app's bridge (apps/desktop/src/bridge.ts): loopback HTTP with a secret token. It
 * renders PDFs, reads pages and opens form windows in Electron's own Chromium, so users need no
 * browser setup.
 */
export const hasBridge = () => !!config.bridge

/** The desktop answered with an error status (it ran, and said what went wrong). */
export class BridgeError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'BridgeError'
  }
}

const call = async (path: string, body: unknown, timeoutMs = 60_000) => {
  const b = config.bridge
  if (!b) throw new Error('No desktop bridge')
  const start = Date.now()
  let res: Response
  try {
    res = await fetch(`${b.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    const s = ((Date.now() - start) / 1000).toFixed(1)
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`The desktop app didn't answer ${path} within ${timeoutMs / 1000}s (gave up after ${s}s)`)
    throw new Error(`The desktop app couldn't be reached for ${path} after ${s}s: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (!res.ok) {
    const text = await res.text()
    let msg = text.slice(0, 300)
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg
    } catch {
      // not JSON
    }
    throw new BridgeError(path, res.status, `Desktop ${path} failed (${res.status}): ${msg}`)
  }
  return res
}

export const bridgePdf = async (html: string) => Buffer.from(await (await call('/pdf', { html })).arrayBuffer())

export const bridgeRead = async (url: string) =>
  (await (await call('/read', { url }, 60_000)).json()) as { url: string; status: number | null; title: string; text: string; jsonLd: string[] }

const openOnce = async (url: string, guard: string, timeoutMs: number) => (await (await call('/tabs', { url, guard }, timeoutMs)).json()) as { id: string; cdpEndpoint: string }

/** Worth another try after a reset: the open ran out of time, or the desktop couldn't be reached. Not a bad URL. */
const retryable = (e: unknown) => !(e instanceof BridgeError) || e.status === 504 || e.status === 503

/**
 * Open a form window. When the open times out, check the desktop still answers; if it does, reset
 * the forms session (calls off the open that hung, drops its connections) and try once more.
 */
export const bridgeOpenTab = async (url: string, guard: string, timeoutMs: number = FORM_OPEN_SERVER_MS) => {
  try {
    return await openOnce(url, guard, timeoutMs)
  } catch (first) {
    const why = first instanceof Error ? first.message : String(first)
    console.error(`[bridge] opening ${url} failed: ${why}`)
    if (!retryable(first)) throw first
    const alive = await call('/ping', {}, Math.min(5000, timeoutMs)).then(
      () => true,
      () => false,
    )
    if (!alive) throw new Error(`The Sidedoor desktop app stopped answering (it may be showing an error dialog; close it or restart Sidedoor). Opening ${url}: ${why}`)
    // An older desktop has no reset: retrying is still worth it.
    await call('/tabs/reset', {}, 10_000).catch((e: unknown) => console.error(`[bridge] reset failed: ${e instanceof Error ? e.message : String(e)}`))
    console.error(`[bridge] forms session reset, opening ${url} again`)
    try {
      return await openOnce(url, guard, timeoutMs)
    } catch (second) {
      const again = second instanceof Error ? second.message : String(second)
      console.error(`[bridge] opening ${url} failed again: ${again}`)
      throw new Error(`Couldn't open the form window. ${why}. After resetting the forms session and trying again: ${again}`)
    }
  }
}

export const bridgeFinishTab = async (id: string, banner: string) => {
  await call(`/tabs/${encodeURIComponent(id)}/finish`, { banner })
}

export const bridgeUnguardTab = async (id: string) => {
  await call(`/tabs/${encodeURIComponent(id)}/unguard`, {})
}

/** Put the guard back on a window left open, to fill it again. Fails (404) when it was closed. */
export const bridgeGuardTab = async (id: string, guard: string) => {
  await call(`/tabs/${encodeURIComponent(id)}/guard`, { guard })
}

export const bridgeCloseTab = async (id: string) => {
  await call(`/tabs/${encodeURIComponent(id)}/close`, {})
}

export const bridgeNotify = async (n: { title: string; body: string; url?: string }) => {
  await call('/notify', n, 5000)
}
