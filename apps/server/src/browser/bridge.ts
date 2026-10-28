import { config } from '../config'

/**
 * The desktop app's bridge (apps/desktop/src/bridge.ts): loopback HTTP with a secret token. It
 * renders PDFs, reads pages and opens form windows in Electron's own Chromium, so users need no
 * browser setup.
 */
export const hasBridge = () => !!config.bridge

const call = async (path: string, body: unknown, timeoutMs = 60_000) => {
  const b = config.bridge
  if (!b) throw new Error('No desktop bridge')
  const res = await fetch(`${b.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${b.token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`Desktop ${path} failed (${res.status}): ${(await res.text()).slice(0, 300)}`)
  return res
}

export const bridgePdf = async (html: string) => Buffer.from(await (await call('/pdf', { html })).arrayBuffer())

export const bridgeRead = async (url: string) =>
  (await (await call('/read', { url }, 60_000)).json()) as { url: string; status: number | null; title: string; text: string; jsonLd: string[] }

export const bridgeOpenTab = async (url: string, guard: string) => (await (await call('/tabs', { url, guard }, 60_000)).json()) as { id: string; cdpEndpoint: string }

export const bridgeFinishTab = async (id: string, banner: string) => {
  await call(`/tabs/${encodeURIComponent(id)}/finish`, { banner })
}

export const bridgeNotify = async (n: { title: string; body: string; url?: string }) => {
  await call('/notify', n, 5000)
}
