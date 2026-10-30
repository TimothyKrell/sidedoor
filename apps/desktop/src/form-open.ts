import type { ServerResponse } from 'node:http'
import { FORM_OPEN_STEPS } from '@sidedoor/shared/form-window'

/**
 * Opening a form window, one step at a time, each with its own time limit, so a page that hangs
 * fails with the step that hung instead of using up the server's whole wait. Electron stays in
 * bridge.ts; this takes the window's operations so it can be tested without one.
 */

export type FormOpenStep = 'load' | 'Page.enable' | 'guard' | `frame ${number} script` | 'aborted'

export class FormOpenError extends Error {
  constructor(
    readonly step: FormOpenStep,
    readonly elapsedMs: number,
    readonly url: string,
    detail: string,
  ) {
    super(`Opening the form window failed at ${step} after ${(elapsedMs / 1000).toFixed(1)}s: ${detail} (${url})`)
    this.name = 'FormOpenError'
  }
  /** It ran out of time, as opposed to being called off. */
  get timedOut() {
    return this.step !== 'aborted'
  }
}

const TIMEOUT = Symbol('timeout')

/** Settles with `p`, or with TIMEOUT after `ms`, or rejects when `signal` aborts. */
const within = <T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T | typeof TIMEOUT> =>
  new Promise((ok, fail) => {
    const t = setTimeout(() => done(() => ok(TIMEOUT)), ms)
    const onAbort = () => done(() => fail(new DOMException('Aborted', 'AbortError')))
    const done = (f: () => void) => {
      clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      f()
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => done(() => ok(v)),
      (e: unknown) => done(() => fail(e)),
    )
  })

/** Run each frame's script with a time limit; rejections (a frame that went away) don't count. Never throws. */
export const inEveryFrame = async (frames: Array<{ run: () => Promise<unknown> }>, frameMs: number = FORM_OPEN_STEPS.frameMs) => {
  for (const f of frames) await within(f.run(), frameMs).catch(() => {})
}

export interface FormWindowOps {
  /** Navigate to the form. Rejections are expected (redirects abort the first navigation). */
  load: (url: string) => Promise<unknown>
  /** Attach the debugger. */
  attach: () => void
  enablePage: () => Promise<unknown>
  /** Register the guard for later documents; resolves with its identifier. */
  addGuard: () => Promise<string>
  /** The frames of the page open now, each able to run the guard. */
  frames: () => Array<{ run: () => Promise<unknown> }>
  /** Close the window and release everything it holds (debugger, listeners). Called on any failure. */
  destroy: () => void
}

export interface FormOpenOptions {
  /** Called off when the server stops waiting: the window is destroyed. */
  signal?: AbortSignal
  limits?: Record<keyof typeof FORM_OPEN_STEPS, number>
  log?: (line: string) => void
  now?: () => number
}

export const openFormWindow = async (url: string, ops: FormWindowOps, o: FormOpenOptions = {}): Promise<{ guardId: string }> => {
  const limits: Record<keyof typeof FORM_OPEN_STEPS, number> = o.limits ?? FORM_OPEN_STEPS
  const now = o.now ?? Date.now
  const start = now()
  const fail = (step: FormOpenStep, detail: string) => new FormOpenError(step, now() - start, url, detail)
  const step = async <T>(name: FormOpenStep, p: () => Promise<T>, ms: number, onTimeout?: FormOpenStep, detail?: string): Promise<T> => {
    let r: T | typeof TIMEOUT
    try {
      r = await within(p(), ms, o.signal)
    } catch (e) {
      if (o.signal?.aborted) throw fail('aborted', `the server stopped waiting during ${name}`)
      throw fail(name, e instanceof Error ? e.message : String(e))
    }
    if (r === TIMEOUT) throw fail(onTimeout ?? name, detail ?? `${name} didn't finish within ${(ms / 1000).toFixed(0)}s`)
    return r
  }
  try {
    if (o.signal?.aborted) throw fail('aborted', 'the server stopped waiting before the window opened')
    // A page that never fires load (long polling, a stuck ad) can still be filled; Page.enable decides.
    const loaded = await step('load', () => ops.load(url).then(() => true, () => true), limits.loadMs).catch((e: unknown) => {
      if (e instanceof FormOpenError && e.step === 'load') return false
      throw e
    })
    if (!loaded) o.log?.(`[bridge] form page still loading after ${(limits.loadMs / 1000).toFixed(0)}s, going on: ${url}`)
    ops.attach()
    // CDP's Page domain doesn't answer for a window that never loaded: name the load when that's why.
    await step('Page.enable', ops.enablePage, limits.pageEnableMs, loaded ? undefined : 'load', loaded ? undefined : `the page didn't load within ${(limits.loadMs / 1000).toFixed(0)}s and then didn't answer Page.enable within ${(limits.pageEnableMs / 1000).toFixed(0)}s`)
    const guardId = await step('guard', ops.addGuard, limits.guardMs)
    // And the page that's open now, in every frame. A frame that went away is fine; one that hangs isn't.
    const framesStart = now()
    let i = 0
    for (const f of ops.frames()) {
      const left = limits.framesMs - (now() - framesStart)
      if (left <= 0) throw fail(`frame ${i} script`, `the guard didn't reach every frame within ${(limits.framesMs / 1000).toFixed(0)}s`)
      await step(`frame ${i} script`, () => f.run().catch(() => {}), Math.min(limits.frameMs, left))
      i++
    }
    if (o.signal?.aborted) throw fail('aborted', 'the server stopped waiting')
    return { guardId }
  } catch (e) {
    ops.destroy()
    if (e instanceof FormOpenError) o.log?.(`[bridge] ${e.message}`)
    throw e
  }
}

/** Aborts when the client hangs up before the response is sent: the server stopped waiting. */
export const abortOnHangUp = (res: ServerResponse) => {
  const c = new AbortController()
  res.on('close', () => !res.writableFinished && c.abort())
  return c
}
