import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { FORM_OPEN_DESKTOP_MAX_MS, FORM_OPEN_SERVER_MS } from '@sidedoor/shared/form-window'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { initConfig } from '../src/config'
import { bridgeOpenTab } from '../src/browser/bridge'

// A stand-in for the desktop bridge: each test says how /tabs answers.
type Handler = (req: IncomingMessage, res: ServerResponse, n: number) => void
const desktop = { tabs: null as Handler | null, ping: true, calls: [] as string[], hungUp: 0 }
const server = createServer((req, res) => {
  const path = req.url ?? ''
  // Only the server's own calls (other processes on this machine may probe the port).
  if (req.headers.authorization !== 'Bearer t') return res.writeHead(401).end()
  desktop.calls.push(path)
  req.resume()
  req.on('end', () => {
    if (path === '/ping') {
      if (desktop.ping) res.end('{"ok":true}')
      return
    }
    if (path === '/tabs/reset') return res.end('{"ok":true}')
    res.on('close', () => !res.writableFinished && desktop.hungUp++)
    desktop.tabs?.(req, res, desktop.calls.filter((c) => c === '/tabs').length)
  })
})
const ok = (res: ServerResponse) => res.end(JSON.stringify({ id: 'abc', cdpEndpoint: 'ws://127.0.0.1/cdp/abc' }))
const err = (res: ServerResponse, status: number, error: string) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error }))
}
const URL = 'https://jobs.example.com/apply'

beforeAll(async () => {
  const port = await new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)))
  initConfig({ mode: 'web', bridge: { url: `http://127.0.0.1:${port}`, token: 't' } })
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})
beforeEach(() => {
  Object.assign(desktop, { tabs: null, ping: true, calls: [], hungUp: 0 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

test('the server waits longer than the desktop can take', () => {
  expect(FORM_OPEN_DESKTOP_MAX_MS).toBeLessThan(FORM_OPEN_SERVER_MS)
})

test('an open that works is used as is', async () => {
  desktop.tabs = (_q, res) => ok(res)
  expect(await bridgeOpenTab(URL, 'guard()')).toEqual({ id: 'abc', cdpEndpoint: 'ws://127.0.0.1/cdp/abc' })
  expect(desktop.calls).toEqual(['/tabs'])
})

test('a stuck open is called off, the session reset, and the retry succeeds', async () => {
  desktop.tabs = (_q, res, n) => (n === 1 ? undefined : ok(res))
  expect(await bridgeOpenTab(URL, 'guard()', 150)).toEqual({ id: 'abc', cdpEndpoint: 'ws://127.0.0.1/cdp/abc' })
  expect(desktop.calls).toEqual(['/tabs', '/ping', '/tabs/reset', '/tabs'])
  // The desktop sees the server hang up on the first open: that's what closes its window.
  await vi.waitFor(() => expect(desktop.hungUp).toBe(1))
})

test('a step that timed out on the desktop is retried, and both failures are named', async () => {
  desktop.tabs = (_q, res) => err(res, 504, `Opening the form window failed at Page.enable after 45.0s: Page.enable didn't finish within 10s (${URL})`)
  const e = await bridgeOpenTab(URL, 'guard()').catch((x: Error) => x)
  expect(e).toBeInstanceOf(Error)
  expect((e as Error).message).toMatch(/^Couldn't open the form window\. Desktop \/tabs failed \(504\): .*at Page\.enable after 45\.0s.*After resetting the forms session and trying again: .*Page\.enable/)
  expect((e as Error).message).toContain(URL)
  expect(desktop.calls).toEqual(['/tabs', '/ping', '/tabs/reset', '/tabs'])
})

test("a desktop that doesn't answer at all fails fast, saying so", async () => {
  desktop.ping = false
  const e = await bridgeOpenTab(URL, 'guard()', 100).catch((x: Error) => x)
  expect((e as Error).message).toMatch(/desktop app stopped answering.*didn't answer \/tabs within 0\.1s/)
  expect(desktop.calls).toEqual(['/tabs', '/ping'])
})

test("a form the desktop refuses isn't retried", async () => {
  desktop.tabs = (_q, res) => err(res, 500, 'Only web pages can be opened')
  const e = await bridgeOpenTab('ftp://x', 'guard()').catch((x: Error) => x)
  expect((e as Error).message).toBe('Desktop /tabs failed (500): Only web pages can be opened')
  expect(desktop.calls).toEqual(['/tabs'])
})
