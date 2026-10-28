import { lookup } from 'node:dns/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { connect, isIP, type Socket } from 'node:net'
import { isLocalHostname, isPrivateAddress } from './net'

/**
 * A loopback HTTP proxy that only reaches the public web. Browsers that load pages we don't control
 * (page reads, form windows) send every request through it, each redirect hop included. It resolves
 * the host itself, refuses if any address is private, and connects to the address it checked, so
 * DNS rebinding between the check and the connection can't reach this machine or the local network.
 *
 * Point Chromium at it with `--proxy-server=http://127.0.0.1:<port>` and `--proxy-bypass-list=<-loopback>`
 * (Chromium otherwise sends localhost straight past any proxy).
 */

const resolvePublic = async (host: string): Promise<string | null> => {
  const h = host.replace(/^\[|\]$/g, '')
  if (isLocalHostname(h)) return null
  if (isIP(h)) return isPrivateAddress(h) ? null : h
  try {
    const addrs = await lookup(h, { all: true, verbatim: true })
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return null
    return addrs[0]!.address
  } catch {
    return null
  }
}

const refuse = (sock: Socket, status = 403) => {
  sock.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Bad Request'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`)
}

/** Splits "host:port" and "[v6]:port". */
const hostPort = (s: string, fallback: number) => {
  const m = s.match(/^\[([^\]]+)\](?::(\d+))?$/) ?? s.match(/^([^:]+)(?::(\d+))?$/)
  return m ? { host: m[1]!, port: m[2] ? Number(m[2]) : fallback } : null
}

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535
/** Idle connections close after this long. */
const IDLE_MS = 120_000

export interface PublicProxy {
  port: number
  url: string
  close: () => Promise<void>
}

/** `port` 0 picks a free one; a fixed port lets a long-lived browser keep its proxy setting across restarts. */
export const startPublicProxy = async (port = 0): Promise<PublicProxy> => {
  // Nothing a client sends may crash the process this runs in: every handler catches, every socket
  // has an error listener, and both sides of a connection close together.
  const server: Server = createServer((req, res) => {
    void (async () => {
      // Plain http: the request line carries an absolute URL.
      let u: URL
      try {
        u = new URL(req.url ?? '')
      } catch {
        res.writeHead(400).end()
        return
      }
      const port = Number(u.port || 80)
      if (u.protocol !== 'http:' || !validPort(port)) {
        res.writeHead(400).end()
        return
      }
      const ip = await resolvePublic(u.hostname)
      if (res.destroyed) return
      if (!ip) {
        res.writeHead(403, { 'content-type': 'text/plain' }).end('Sidedoor only opens public web pages here.')
        return
      }
      const headers = { ...req.headers }
      delete headers['proxy-connection']
      delete headers['proxy-authorization']
      const up = httpRequest({ host: ip, port, method: req.method, path: `${u.pathname}${u.search}`, headers, setHost: false, timeout: IDLE_MS }, (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      })
      up.on('timeout', () => up.destroy())
      up.on('error', () => (res.headersSent ? res.destroy() : res.writeHead(502).end()))
      // The browser gave up (navigated away, closed the tab): drop the upstream request too.
      res.on('close', () => up.destroy())
      req.pipe(up)
    })().catch(() => res.destroy())
  })
  server.on('clientError', (_e, sock: Socket) => sock.destroy())

  // https (and wss): a tunnel to host:port, opened only to a public address.
  server.on('connect', (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on('error', () => {})
    void (async () => {
      const hp = hostPort(req.url ?? '', 443)
      if (!hp || !validPort(hp.port)) return refuse(client, 400)
      const ip = await resolvePublic(hp.host)
      if (client.destroyed) return
      if (!ip) return refuse(client)
      const up = connect({ port: hp.port, host: ip, timeout: IDLE_MS }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) up.write(head)
        up.pipe(client)
        client.pipe(up)
      })
      up.on('timeout', () => up.destroy())
      up.on('error', () => client.destroy())
      up.on('close', () => client.destroy())
      client.on('close', () => up.destroy())
    })().catch(() => client.destroy())
  })

  // Plain ws:// upgrades aren't needed by any job board; refuse them rather than tunnel unchecked.
  server.on('upgrade', (_req, sock: Socket) => {
    sock.on('error', () => {})
    refuse(sock)
  })

  await new Promise<void>((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', done)
  })
  const bound = (server.address() as { port: number }).port
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    close: () => new Promise((done) => server.close(() => done())),
  }
}
