import { createServer } from 'node:http'
import { FORM_OPEN_DESKTOP_MAX_MS, FORM_OPEN_SERVER_MS, FORM_OPEN_STEPS } from '@sidedoor/shared/form-window'
import { expect, test, vi } from 'vitest'
import { createCdpRelay } from '../src/cdp-relay'
import { abortOnHangUp, FormOpenError, openFormWindow, type FormWindowOps } from '../src/form-open'

const URL = 'https://jobs.example.com/apply'
const never = () => new Promise<never>(() => {})
// Short limits so a hang shows in milliseconds; the ratios match the real ones.
const LIMITS = { loadMs: 60, pageEnableMs: 30, guardMs: 20, frameMs: 15, framesMs: 40 } as const

/** A window whose steps all work, with any of them swapped out. */
const ops = (over: Partial<FormWindowOps> = {}) => {
  const calls: string[] = []
  const o: FormWindowOps = {
    load: async () => void calls.push('load'),
    attach: () => void calls.push('attach'),
    enablePage: async () => void calls.push('enable'),
    addGuard: async () => (calls.push('guard'), 'G1'),
    frames: () => [{ run: async () => void calls.push('frame') }],
    destroy: () => void calls.push('destroy'),
    ...over,
  }
  return { o, calls }
}

const failure = async (p: Promise<unknown>) => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  )
  expect(e).toBeInstanceOf(FormOpenError)
  return e as FormOpenError
}

test('the desktop always answers before the server stops waiting', () => {
  const sum = FORM_OPEN_STEPS.loadMs + FORM_OPEN_STEPS.pageEnableMs + FORM_OPEN_STEPS.guardMs + FORM_OPEN_STEPS.framesMs
  expect(FORM_OPEN_DESKTOP_MAX_MS).toBe(sum)
  expect(FORM_OPEN_STEPS.frameMs).toBeLessThanOrEqual(FORM_OPEN_STEPS.framesMs)
  // Clear headroom, not a tie: the old 45s + 15s used the server's whole 60s.
  expect(FORM_OPEN_SERVER_MS - FORM_OPEN_DESKTOP_MAX_MS).toBeGreaterThanOrEqual(20_000)
})

test('an open after a previous window closed starts clean and succeeds', async () => {
  const first = ops()
  await openFormWindow(URL, first.o, { limits: LIMITS })
  // The first window closes while Playwright still sends commands: they fail, nothing throws.
  let destroyed = false
  const out: Array<Record<string, unknown>> = []
  const relay = createCdpRelay(
    {
      send: (m, p, s) => {
        if (destroyed) throw new TypeError('Object has been destroyed')
        return Promise.resolve({ m, p, s })
      },
      targetId: async () => 'T1',
      url: () => URL,
      title: () => 'Apply',
      userAgent: () => 'UA',
    },
    (m) => out.push(JSON.parse(m)),
  )
  destroyed = true
  expect(() => relay.receive(JSON.stringify({ id: 9, method: 'Runtime.evaluate', sessionId: 'sidedoor-page' }))).not.toThrow()
  await new Promise((r) => setTimeout(r, 0))
  expect(out).toEqual([{ id: 9, error: { code: -32000, message: 'Object has been destroyed' }, sessionId: 'sidedoor-page' }])
  // The next one opens.
  const second = ops()
  expect(await openFormWindow(URL, second.o, { limits: LIMITS })).toEqual({ guardId: 'G1' })
  expect(second.calls).toEqual(['load', 'attach', 'enable', 'guard', 'frame'])
})

test('a page that never loads, and then never answers, fails at load', async () => {
  const { o, calls } = ops({ load: never, enablePage: never })
  const log = vi.fn()
  const start = Date.now()
  const e = await failure(openFormWindow(URL, o, { limits: LIMITS, log }))
  expect(e.step).toBe('load')
  expect(e.timedOut).toBe(true)
  expect(e.message).toMatch(/failed at load after \d+\.\ds: .*didn't load.*Page\.enable.*\(https:\/\/jobs\.example\.com\/apply\)/)
  expect(Date.now() - start).toBeLessThan(LIMITS.loadMs + LIMITS.pageEnableMs + 50)
  expect(calls.at(-1)).toBe('destroy')
  expect(log).toHaveBeenCalledWith(expect.stringContaining('failed at load'))
})

test('a page that never loads but answers is still opened', async () => {
  const { o } = ops({ load: never })
  expect(await openFormWindow(URL, o, { limits: LIMITS })).toEqual({ guardId: 'G1' })
})

test('a load that rejects (a redirect aborted it) goes on', async () => {
  const { o } = ops({ load: () => Promise.reject(new Error('ERR_ABORTED (-3)')) })
  expect(await openFormWindow(URL, o, { limits: LIMITS })).toEqual({ guardId: 'G1' })
})

test('Page.enable that hangs fails at Page.enable', async () => {
  const { o, calls } = ops({ enablePage: never })
  const e = await failure(openFormWindow(URL, o, { limits: LIMITS }))
  expect(e.step).toBe('Page.enable')
  expect(e.message).toContain("Page.enable didn't finish within")
  expect(e.elapsedMs).toBeLessThan(LIMITS.pageEnableMs + 30)
  expect(calls.at(-1)).toBe('destroy')
})

test('a frame script that hangs fails naming the frame', async () => {
  const { o, calls } = ops({ frames: () => [{ run: async () => 'ok' }, { run: never }, { run: async () => 'ok' }] })
  const e = await failure(openFormWindow(URL, o, { limits: LIMITS }))
  expect(e.step).toBe('frame 1 script')
  expect(e.elapsedMs).toBeLessThan(LIMITS.frameMs + 30)
  expect(calls.at(-1)).toBe('destroy')
})

test('many slow frames stop at the overall frame limit', async () => {
  const slow = { run: () => new Promise((r) => setTimeout(r, 12)) }
  const { o } = ops({ frames: () => Array.from({ length: 10 }, () => slow) })
  const e = await failure(openFormWindow(URL, o, { limits: LIMITS }))
  expect(e.step).toMatch(/^frame \d script$/)
  expect(e.elapsedMs).toBeLessThan(LIMITS.framesMs + 40)
})

test("a frame that went away doesn't fail the open", async () => {
  const { o } = ops({ frames: () => [{ run: () => Promise.reject(new Error('frame detached')) }] })
  expect(await openFormWindow(URL, o, { limits: LIMITS })).toEqual({ guardId: 'G1' })
})

test('the server hanging up calls the open off and closes the window', async () => {
  let onDestroy = () => {}
  const destroyed = new Promise<void>((r) => (onDestroy = r))
  let step: string | undefined
  const server = createServer((_req, res) => {
    const c = abortOnHangUp(res)
    const { o } = ops({ load: never, destroy: () => onDestroy() })
    // Long limits: only the hang-up can end this.
    openFormWindow(URL, o, { signal: c.signal, limits: FORM_OPEN_STEPS }).catch((e: FormOpenError) => {
      step = e.step
    })
  })
  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)))
  try {
    await fetch(`http://127.0.0.1:${port}/tabs`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(50) }).catch(() => {})
    await destroyed
    await new Promise((r) => setTimeout(r, 0))
    expect(step).toBe('aborted')
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('an open called off before it starts never makes a window usable', async () => {
  const c = new AbortController()
  c.abort()
  const { o, calls } = ops()
  const e = await failure(openFormWindow(URL, o, { signal: c.signal, limits: LIMITS }))
  expect(e.step).toBe('aborted')
  expect(e.timedOut).toBe(false)
  expect(calls).toEqual(['destroy'])
})
