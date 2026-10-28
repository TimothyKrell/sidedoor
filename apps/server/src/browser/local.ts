import { spawn } from 'node:child_process'
import type { Browser, BrowserContext, Page, Route } from 'playwright-core'
import { paths } from '../config'
import { requireChrome } from './chrome'
import { BANNER, GUARD } from './guard'
import { startPublicProxy, type PublicProxy } from '@sidedoor/shared/public-proxy'
import { isPublicHost } from './guard-net'

// Loaded on first use: only `sidedoor serve` without the desktop app needs it.
const pw = () => import('playwright-core').then((m) => m.chromium)

/**
 * Browser work without the desktop app: headless Chrome for PDFs and reading pages, and a visible
 * Chrome window with its own profile (so ATS logins stick) for filling forms.
 */

/**
 * Every page we don't control goes through the public-only proxy, so redirects and DNS rebinding
 * can't reach this machine or the local network. One proxy per port (see FORM_PROXY_PORT).
 */
const proxies = new Map<number, Promise<PublicProxy>>()
const publicProxy = (port: number) => {
  let p = proxies.get(port)
  if (!p) {
    p = startPublicProxy(port).catch((e: unknown) => {
      proxies.delete(port)
      throw e
    })
    proxies.set(port, p)
  }
  return p
}
// WebRTC's UDP would go around the proxy; only proxied connections are allowed.
const proxyArgs = (p: PublicProxy) => [`--proxy-server=${p.url}`, '--proxy-bypass-list=<-loopback>', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp']
/** The form window outlives restarts, so its proxy keeps one port; the headless browser takes any free one. */
const FORM_PROXY_PORT = Number(process.env.SIDEDOOR_PROXY_PORT ?? 9334)

let headless: Promise<Browser> | null = null
const headlessBrowser = () => {
  headless ??= pw()
    .then(async (chromium) => chromium.launch({ executablePath: requireChrome(), headless: true, args: proxyArgs(await publicProxy(0)) }))
    .then((b) => {
      b.on('disconnected', () => (headless = null))
      return b
    })
    .catch((e: unknown) => {
      // A failed launch shouldn't stick: the next PDF or page read tries again.
      headless = null
      throw e
    })
  return headless
}

export const localPdf = async (html: string) => {
  const b = await headlessBrowser()
  const ctx = await b.newContext()
  try {
    const page = await ctx.newPage()
    await page.setContent(html, { waitUntil: 'networkidle', timeout: 30_000 }).catch(() => {})
    await page.evaluate(() => document.fonts.ready).catch(() => {})
    return await page.pdf({ preferCSSPageSize: true, printBackground: true })
  } finally {
    await ctx.close().catch(() => {})
  }
}

/**
 * A first check on every request a context makes. Playwright routes only the first hop of a redirect
 * chain; the proxy is what covers the rest.
 */
const publicRoute = (skip?: (r: Route) => boolean) => async (r: Route) => {
  if (skip?.(r)) return r.abort()
  const u = new URL(r.request().url())
  if (u.protocol === 'data:' || u.protocol === 'blob:') return r.continue()
  if (!/^https?:$/.test(u.protocol) || !(await isPublicHost(u.hostname))) return r.abort()
  return r.continue()
}
const heavy = (r: Route) => ['image', 'media', 'font'].includes(r.request().resourceType())

export const localRead = async <T>(url: string, fn: (page: Page) => Promise<T>): Promise<T> => {
  const b = await headlessBrowser()
  // Headless Chrome says "HeadlessChrome" in its user agent, which some boards refuse.
  const ctx = await b.newContext({
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${b.version().split('.')[0]}.0.0.0 Safari/537.36`,
    viewport: { width: 1280, height: 1000 },
  })
  try {
    await ctx.route('**/*', publicRoute(heavy))
    const page = await ctx.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    return await fn(page)
  } finally {
    await ctx.close().catch(() => {})
  }
}

// ------------------------------------------------------------------------------- form window

const CDP_PORT = Number(process.env.SIDEDOOR_BROWSER_PORT ?? 9333)
const cdpEndpoint = `http://127.0.0.1:${CDP_PORT}`

const cdpUp = async () => {
  try {
    return (await fetch(`${cdpEndpoint}/json/version`, { signal: AbortSignal.timeout(1500) })).ok
  } catch {
    return false
  }
}

const ensureWindow = async () => {
  const local = process.env.SIDEDOOR_TEST_LOCAL_FORMS === '1'
  // Started before the window, which keeps using it after this check.
  const formProxyArgs = local ? [] : proxyArgs(await publicProxy(FORM_PROXY_PORT))
  if (await cdpUp()) return
  const child = spawn(
    requireChrome(),
    [
      ...formProxyArgs,
      `--remote-debugging-port=${CDP_PORT}`,
      '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${paths.browserProfile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1280,1000',
      // Keep a window that's behind others rendering at full speed, so the agent can fill it there.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()
  for (let i = 0; i < 40; i++) {
    if (await cdpUp()) return
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`The browser did not open a debugging port on ${CDP_PORT}`)
}

// The guard runs in every frame, and many forms live in one (Stripe embeds Greenhouse), so lift it in all of them.
const everyFrame = (p: Page, js: string) => Promise.all(p.frames().map((f) => f.evaluate(js).catch(() => {})))

export const localFormTab = async (url: string) => {
  await ensureWindow()
  const browser = await (await pw()).connectOverCDP(cdpEndpoint)
  const context: BrowserContext = browser.contexts()[0] ?? (await browser.newContext())
  await context.addInitScript(GUARD)
  // While an agent drives the window it stays on the public web (routes end when we disconnect).
  if (process.env.SIDEDOOR_TEST_LOCAL_FORMS !== '1') await context.route('**/*', publicRoute())
  // Reuse the blank tab of a window that was just launched; otherwise open a new window without
  // activating it (a hidden background tab stops rendering, and clicks there stall).
  let page = context.pages().find((p) => p.url() === 'about:blank')
  if (!page) {
    const cdp = await browser.newBrowserCDPSession()
    const opened = context.waitForEvent('page', { timeout: 15_000 })
    await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true })
    page = await opened
    await cdp.detach().catch(() => {})
  }
  for (const p of context.pages()) if (p !== page) await everyFrame(p, 'window.__sidedoorFilling = false')
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
  await page.evaluate(GUARD).catch(() => {})
  // Stay connected while the agent fills: the guard's init script lives as long as this session.
  return {
    cdpEndpoint,
    finish: async () => {
      for (const p of context.pages()) {
        await everyFrame(p, 'window.__sidedoorFilling = false')
        await p.evaluate(BANNER).catch(() => {})
      }
      // Disconnects only; the window (we launched it, not Playwright) stays open for review.
      await browser.close().catch(() => {})
    },
  }
}
