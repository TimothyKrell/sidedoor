import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isLocalHostname, isPrivateAddress } from '@sidedoor/shared/net'
import { startPublicProxy } from '@sidedoor/shared/public-proxy'
import { join } from 'node:path'
import { BrowserWindow, Notification, session, type WebContents } from 'electron'
import { WebSocketServer } from 'ws'
import { createCdpRelay } from './cdp-relay'
import { iconPath } from './paths'

/**
 * What the server asks of the desktop app, over loopback HTTP with a secret token:
 *   POST /pdf               HTML → PDF with Chromium's printer (no browser install needed)
 *   POST /read              load a page with its JavaScript and return its text
 *   POST /tabs              open an application form in its own window, with the submit guard
 *   POST /tabs/:id/finish   lift the guard and show the review banner
 *   WS   /cdp/:id           CDP for that window (Playwright in the server drives it)
 *   POST /notify            native notification
 */

export interface Bridge {
  url: string
  token: string
  close: () => void
}

interface FormTab {
  id: string
  win: BrowserWindow
  guardId: string | null
}

const FORMS_PARTITION = 'persist:sidedoor-forms'

const readJson = (req: IncomingMessage) =>
  new Promise<Record<string, unknown>>((ok, fail) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      try {
        ok(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {})
      } catch (e) {
        fail(e)
      }
    })
    req.on('error', fail)
  })

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Wait until a page stops making requests for `quietMs` (at most `maxMs`): most boards fetch the posting after load. */
const settle = (wc: WebContents, quietMs = 1200, maxMs = 12_000) =>
  new Promise<void>((done) => {
    let last = Date.now()
    const ses = wc.session
    const onReq = () => {
      last = Date.now()
    }
    ses.webRequest.onCompleted(onReq)
    const start = Date.now()
    const tick = setInterval(() => {
      if (Date.now() - last > quietMs || Date.now() - start > maxMs) {
        clearInterval(tick)
        ses.webRequest.onCompleted(null as never)
        done()
      }
    }, 200)
  })

const isWeb = (u: string) => /^https?:\/\//i.test(u)

/** Answers expire quickly so a host can't pass once and then rebind to a local address. */
const hostCache = new Map<string, { ok: boolean; at: number }>()
const isPublicHost = async (host: string) => {
  const h = host.replace(/^\[|\]$/g, '')
  if (isLocalHostname(h)) return false
  if (isIP(h)) return !isPrivateAddress(h)
  const hit = hostCache.get(h)
  if (hit && Date.now() - hit.at < 30_000) return hit.ok
  const ok = await lookup(h, { all: true, verbatim: true }).then((a) => a.length > 0 && a.every((x) => !isPrivateAddress(x.address)), () => false)
  hostCache.set(h, { ok, at: Date.now() })
  return ok
}

/**
 * Keep every request from a session on the public web, redirects included. Electron doesn't report
 * the address a response came from, so the short cache TTL above is what limits DNS rebinding.
 */
const publicOnly = (ses: Electron.Session, o: { skip?: (d: Electron.OnBeforeRequestListenerDetails) => boolean } = {}) => {
  ses.webRequest.onBeforeRequest((d, cb) => {
    if (o.skip?.(d)) return cb({ cancel: true })
    let u: URL
    try {
      u = new URL(d.url)
    } catch {
      return cb({ cancel: true })
    }
    if (u.protocol === 'data:' || u.protocol === 'blob:') return cb({})
    if (!isWeb(d.url)) return cb({ cancel: true })
    void isPublicHost(u.hostname).then((ok) => cb({ cancel: !ok }))
  })
}

/** Pages in these windows are untrusted: no permissions (camera, location, notifications, protocol handlers). */
const harden = (partition: string) => {
  const ses = session.fromPartition(partition)
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false))
  ses.setPermissionCheckHandler(() => false)
  return ses
}

export const startBridge = async (o: { onNotifyClick: (path: string | undefined) => void }): Promise<Bridge> => {
  const token = randomBytes(24).toString('base64url')
  harden(FORMS_PARTITION)
  harden('sidedoor-read')
  harden('sidedoor-pdf')
  // Form windows run pages we don't control with an agent driving them: public web only, like page reads.
  // Untrusted pages reach the network only through the public-only proxy (every redirect hop, the
  // address it actually connects to), with a first check on each request here.
  const proxy = await startPublicProxy()
  const viaProxy = (ses: Electron.Session) => ses.setProxy({ proxyRules: proxy.url, proxyBypassRules: '<-loopback>' })
  // SIDEDOOR_TEST_LOCAL_FORMS=1 lets end-to-end tests fill a form served from this machine.
  if (process.env.SIDEDOOR_TEST_LOCAL_FORMS !== '1') {
    publicOnly(session.fromPartition(FORMS_PARTITION))
    await viaProxy(session.fromPartition(FORMS_PARTITION))
  }
  // Page reads also skip heavy resources.
  publicOnly(session.fromPartition('sidedoor-read'), { skip: (d) => d.resourceType === 'image' || d.resourceType === 'media' || d.resourceType === 'font' })
  await viaProxy(session.fromPartition('sidedoor-read'))
  const tabs = new Map<string, FormTab>()
  const authed = (req: IncomingMessage) => {
    const h = req.headers.authorization ?? ''
    const t = h.startsWith('Bearer ') ? h.slice(7) : (new URL(req.url ?? '/', 'http://x').searchParams.get('token') ?? '')
    const a = Buffer.from(t)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  const pdf = async (html: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'sidedoor-pdf-'))
    const file = join(dir, 'resume.html')
    writeFileSync(file, html)
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true, javascript: false, partition: 'sidedoor-pdf' } })
    try {
      await win.loadFile(file)
      // Web fonts (some themes load them) need a moment after load.
      await sleep(400)
      return await win.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } })
    } finally {
      win.destroy()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  const read = async (url: string) => {
    if (!isWeb(url)) throw new Error('Only web pages can be read')
    const win = new BrowserWindow({ show: false, webPreferences: { partition: 'sidedoor-read', sandbox: true } })
    // WebRTC's UDP would go around the proxy.
    win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // A page being read can't open windows or leave the web.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (e, u) => !isWeb(u) && e.preventDefault())
    win.webContents.on('will-redirect', (e, u) => !isWeb(u) && e.preventDefault())
    try {
      // Headless-looking user agents get refused by some boards; Electron's names Electron.
      win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s?(Electron|Sidedoor)\/[\d.]+/g, ''))
      let status: number | null = null
      win.webContents.on('did-navigate', (_e, _u, code) => {
        status = code
      })
      await Promise.race([win.loadURL(url), sleep(30_000)]).catch(() => {})
      await settle(win.webContents)
      const got = (await win.webContents.executeJavaScript(`({ title: document.title, text: document.body ? document.body.innerText : '', jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent || '') })`)) as { title: string; text: string; jsonLd: string[] }
      return { url: win.webContents.getURL(), status, ...got }
    } finally {
      win.destroy()
    }
  }

  const openTab = async (url: string, guard: string) => {
    if (!isWeb(url)) throw new Error('Only web pages can be opened')
    const id = randomBytes(8).toString('hex')
    // Background window: filling never steals focus. ATS sign-ins persist in its partition.
    const win = new BrowserWindow({
      width: 1200,
      height: 960,
      show: false,
      title: 'Sidedoor · application form',
      autoHideMenuBar: true,
      ...(iconPath() ? { icon: iconPath()! } : {}),
      webPreferences: { partition: FORMS_PARTITION, sandbox: true, contextIsolation: true, backgroundThrottling: false },
    })
    win.showInactive()
    const wc = win.webContents
    // WebRTC's UDP would go around the proxy.
    wc.setWebRTCIPHandlingPolicy('disable_non_proxied_udp')
    // Forms that open a popup (SSO, "apply with LinkedIn") continue in this window, web pages only.
    wc.setWindowOpenHandler(({ url: u }) => {
      if (isWeb(u)) void win.loadURL(u)
      return { action: 'deny' }
    })
    wc.on('will-navigate', (e, u) => !isWeb(u) && e.preventDefault())
    wc.on('will-redirect', (e, u) => !isWeb(u) && e.preventDefault())
    // Load first: CDP's Page domain doesn't answer for a window that never loaded, and a second
    // navigation after a blank one can be dropped. Nothing submits before the agent connects.
    await Promise.race([win.loadURL(url), sleep(45_000)]).catch(() => {})
    wc.debugger.attach('1.3')
    const enabled = await Promise.race([wc.debugger.sendCommand('Page.enable').then(() => true), sleep(15_000).then(() => false)])
    if (!enabled) {
      win.destroy()
      throw new Error(`The form page didn't load: ${url}`)
    }
    // Every later document (next steps, frames, reloads) gets the guard before its own scripts run.
    const r = (await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: guard, runImmediately: true })) as { identifier: string }
    // Cross-origin iframes (an ATS form embedded on a careers page) run in their own process, which
    // the page's script doesn't reach. When Playwright auto-attaches to one, it starts paused; give it
    // the guard before it runs. Detaching the debugger when the fill ends removes these too.
    wc.debugger.on('message', (_e, method: string, params: { sessionId?: string; targetInfo?: { type?: string } }) => {
      if (method !== 'Target.attachedToTarget' || params.targetInfo?.type !== 'iframe' || !params.sessionId) return
      void wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: guard, runImmediately: true }, params.sessionId).catch(() => {})
    })
    const tab: FormTab = { id, win, guardId: r.identifier }
    tabs.set(id, tab)
    win.on('closed', () => tabs.delete(id))
    // And the page that's open now, in every frame.
    for (const f of wc.mainFrame.framesInSubtree) await f.executeJavaScript(guard).catch(() => {})
    return { id, cdpEndpoint: `ws://127.0.0.1:${port}/cdp/${id}?token=${token}` }
  }

  const finishTab = async (id: string, banner: string) => {
    const tab = tabs.get(id)
    if (!tab || tab.win.isDestroyed()) return
    const wc = tab.win.webContents
    // Remove the guard so the next page of a multi-page form lets the user submit.
    if (tab.guardId && wc.debugger.isAttached()) await wc.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: tab.guardId }).catch(() => {})
    tab.guardId = null
    for (const f of wc.mainFrame.framesInSubtree) await f.executeJavaScript('window.__sidedoorFilling = false').catch(() => {})
    await wc.executeJavaScript(banner).catch(() => {})
    if (wc.debugger.isAttached()) wc.debugger.detach()
    tab.win.setTitle('Sidedoor · review, then submit')
  }

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (!authed(req)) return json(res, 401, { error: 'unauthorized' })
    void (async () => {
      try {
        if (req.method !== 'POST') return json(res, 405, { error: 'POST only' })
        const body = await readJson(req)
        if (path === '/pdf') {
          const buf = await pdf(String(body.html ?? ''))
          res.writeHead(200, { 'content-type': 'application/pdf' })
          return res.end(buf)
        }
        if (path === '/read') return json(res, 200, await read(String(body.url)))
        if (path === '/tabs') return json(res, 200, await openTab(String(body.url), String(body.guard ?? '')))
        const fin = path.match(/^\/tabs\/(\w+)\/finish$/)
        if (fin) {
          await finishTab(fin[1]!, String(body.banner ?? ''))
          return json(res, 200, { ok: true })
        }
        if (path === '/notify') {
          if (Notification.isSupported()) {
            const n = new Notification({ title: String(body.title ?? 'Sidedoor'), body: String(body.body ?? ''), ...(iconPath() ? { icon: iconPath()! } : {}) })
            n.on('click', () => o.onNotifyClick(typeof body.url === 'string' ? body.url : undefined))
            n.show()
          }
          return json(res, 200, { ok: true })
        }
        json(res, 404, { error: 'not found' })
      } catch (e) {
        console.error('[bridge]', path, e)
        json(res, 500, { error: e instanceof Error ? e.message : String(e) })
      }
    })()
  })

  // CDP over WebSocket for one form window, relayed to its webContents.debugger.
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req, socket, head) => {
    const m = new URL(req.url ?? '/', 'http://x').pathname.match(/^\/cdp\/(\w+)$/)
    const tab = m ? tabs.get(m[1]!) : undefined
    if (!authed(req) || !tab || tab.win.isDestroyed()) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const wc = tab.win.webContents
      if (!wc.debugger.isAttached()) wc.debugger.attach('1.3')
      const relay = createCdpRelay(
        {
          send: (method, params, sessionId) => wc.debugger.sendCommand(method, params, sessionId),
          targetId: () => wc.debugger.sendCommand('Target.getTargetInfo').then((r: { targetInfo: { targetId: string } }) => r.targetInfo.targetId),
          url: () => wc.getURL(),
          title: () => wc.getTitle(),
          userAgent: () => wc.getUserAgent(),
        },
        (msg) => ws.readyState === ws.OPEN && ws.send(msg),
      )
      const onMessage = (_e: unknown, method: string, params: unknown, sessionId: string) => relay.event(method, params, sessionId || undefined)
      wc.debugger.on('message', onMessage)
      ws.on('message', (data) => relay.receive(data.toString()))
      ws.on('close', () => wc.debugger.off('message', onMessage))
    })
  })

  const port = await new Promise<number>((ok) => server.listen(0, '127.0.0.1', () => ok((server.address() as { port: number }).port)))
  return {
    url: `http://127.0.0.1:${port}`,
    token,
    close: () => {
      wss.close()
      server.close()
      void proxy.close()
    },
  }
}
