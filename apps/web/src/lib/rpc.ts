import type { z } from 'zod'
import type { Router } from '@sidedoor/server/http/router'

/**
 * Typed calls to the server: `rpc.trackPosting({ id })`. Inputs and outputs come from the server's
 * router (apps/server/src/http/router.ts) through a type-only import, so nothing server-side ends
 * up in the bundle.
 */
type Input<K extends keyof Router> = z.input<Router[K]['input']>
type Output<K extends keyof Router> = Awaited<ReturnType<Router[K]['handler']>>
type Call<K extends keyof Router> = undefined extends Input<K> ? (input?: Input<K>) => Promise<Output<K>> : (input: Input<K>) => Promise<Output<K>>

export class RpcError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

export const call = async <K extends keyof Router>(name: K, input?: Input<K>): Promise<Output<K>> => {
  const res = await fetch(`/api/rpc/${String(name)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input ?? {}),
    credentials: 'same-origin',
  })
  const body = (await res.json().catch(() => ({ error: res.statusText }))) as { data?: Output<K>; error?: string }
  if (res.status === 401) window.dispatchEvent(new Event('sidedoor:unauthorized'))
  if (!res.ok) throw new RpcError(body.error ?? `Request failed (${res.status})`, res.status)
  return body.data as Output<K>
}

export const rpc = new Proxy({} as { [K in keyof Router]: Call<K> }, {
  get: (_t, name: string) => (input?: unknown) => call(name as keyof Router, input as never),
})

export type RpcOutput<K extends keyof Router> = Output<K>
