import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isLocalHostname, isPrivateAddress } from '@sidedoor/shared/net'

const cache = new Map<string, { ok: boolean; at: number }>()

/** True when every address the host resolves to is public. Cached for a minute. */
export const isPublicHost = async (host: string) => {
  const h = host.replace(/^\[|\]$/g, '')
  if (isLocalHostname(h)) return false
  if (isIP(h)) return !isPrivateAddress(h)
  const hit = cache.get(h)
  if (hit && Date.now() - hit.at < 60_000) return hit.ok
  let ok = false
  try {
    const addrs = await lookup(h, { all: true, verbatim: true })
    ok = addrs.length > 0 && addrs.every((a) => !isPrivateAddress(a.address))
  } catch {
    ok = false
  }
  cache.set(h, { ok, at: Date.now() })
  return ok
}

export const assertPublicUrl = async (url: string) => {
  const u = new URL(url)
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs')
  if (!(await isPublicHost(u.hostname))) throw new Error('Local and private addresses are off limits')
}
