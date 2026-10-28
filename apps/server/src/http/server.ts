import { createReadStream, existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, normalize, resolve, sep } from 'node:path'
import { z } from 'zod'
import { config, paths } from '../config'
import { subscribe } from '../events'
import { BUILD, VERSION } from '../version'
import { agentFor, isClient, sameOrigin, sessionCookie, validClientToken } from './auth'
import { type RpcName, router } from './router'

/**
 * One port (T3 Code's shape): the web app, `/api/*` for it, `/mcp` for agents, `/files/*` for
 * generated PDFs. Bound to 127.0.0.1 unless the user turns on network access.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage, limit = 2 * 1024 * 1024) =>
  new Promise<Buffer>((ok, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        fail(new Error('Request too large'))
        req.destroy()
      } else chunks.push(c)
    })
    req.on('end', () => ok(Buffer.concat(chunks)))
    req.on('error', fail)
  })

const readJson = async (req: IncomingMessage) => {
  const b = await readBody(req)
  return b.length ? (JSON.parse(b.toString('utf8')) as unknown) : {}
}

/**
 * The web app's pages run only our own scripts. Agent output, packages and resumes contain text
 * from job postings and web pages; this is the backstop if any of it slipped past sanitizing.
 * Resume themes may load Google Fonts; the resume preview frame inherits this policy.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ')

const sendFile = (res: ServerResponse, file: string, cache: string, extra: Record<string, string> = {}) => {
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream'
  const security = type.startsWith('text/html') ? { 'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } : { 'x-content-type-options': 'nosniff' }
  res.writeHead(200, { 'content-type': type, 'cache-control': cache, ...security, ...extra })
  createReadStream(file).pipe(res)
}

/** A path under `root`, or null if it escapes or doesn't exist. */
const inside = (root: string, rel: string) => {
  const p = resolve(root, normalize(decodeURIComponent(rel)).replace(/^([/\\])+/, ''))
  return p.startsWith(root + sep) && existsSync(p) && statSync(p).isFile() ? p : null
}

const sse = (req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' })
  res.write('retry: 3000\n\n')
  // Keep proxies and phones from dropping the idle connection.
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000)
  req.on('close', () => clearInterval(ping))
  return (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`)
}

const ChatBody = z.object({ threadId: z.string().optional(), message: z.string().min(1), pageContext: z.string().optional(), pageLabel: z.string().optional() })

const handleApi = async (req: IncomingMessage, res: ServerResponse, path: string) => {
  // Pairing: a browser exchanges the token from a /pair#token= link for the session cookie.
  if (path === '/api/auth/pair' && req.method === 'POST') {
    const { token } = z.object({ token: z.string() }).parse(await readJson(req))
    if (!validClientToken(token)) return json(res, 401, { error: 'That pairing link is no longer valid. Open a new one from Sidedoor on your computer.' })
    return json(res, 200, { ok: true }, { 'set-cookie': sessionCookie(token, req.headers['x-forwarded-proto'] === 'https') })
  }
  if (path === '/api/auth/status') return json(res, 200, { authorized: isClient(req), version: VERSION })
  if (!isClient(req)) return json(res, 401, { error: 'Not signed in' })
  if (req.method !== 'GET' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' })

  if (path.startsWith('/api/rpc/') && req.method === 'POST') {
    const name = path.slice('/api/rpc/'.length) as RpcName
    const p = router[name] as { input: z.ZodType; handler: (i: unknown) => unknown } | undefined
    if (!p) return json(res, 404, { error: `No such call: ${name}` })
    const parsed = p.input.safeParse(await readJson(req))
    if (!parsed.success) return json(res, 400, { error: `Invalid input: ${parsed.error.message.slice(0, 500)}` })
    try {
      return json(res, 200, { data: (await p.handler(parsed.data)) ?? null })
    } catch (e) {
      console.error(`[rpc] ${name} failed`, e)
      return json(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  }

  if (path === '/api/events') {
    const send = sse(req, res)
    const off = subscribe((e) => send(e))
    req.on('close', off)
    return
  }

  if (path === '/api/chat' && req.method === 'POST') {
    const body = ChatBody.safeParse(await readJson(req))
    if (!body.success) return json(res, 400, { error: body.error.message })
    const { startTurn } = await import('../chat')
    try {
      const { pageContext, pageLabel, threadId, message } = body.data
      return json(res, 200, startTurn({ message, ...(threadId ? { threadId } : {}), ...(pageContext ? { pageContext } : {}), ...(pageLabel ? { pageLabel } : {}) }))
    } catch (e) {
      return json(res, 409, { error: e instanceof Error ? e.message : String(e) })
    }
  }
  const chat = path.match(/^\/api\/chat\/([\w-]+)$/)
  if (chat) {
    const { subscribe: sub, stopTurn } = await import('../chat')
    if (req.method === 'DELETE') {
      stopTurn(chat[1]!)
      return json(res, 200, { ok: true })
    }
    const send = sse(req, res)
    const off = sub(chat[1]!, (e) => {
      send(e)
      if (e.type === 'done') res.end()
    })
    if (!off) {
      send({ type: 'idle' })
      return res.end()
    }
    req.on('close', () => off())
    return
  }

  // Resume upload for import: PDF / DOCX / text → plain text → an import job.
  if (path === '/api/upload/resume' && req.method === 'POST') {
    const name = String(req.headers['x-filename'] ?? 'resume')
    const buf = await readBody(req, 15 * 1024 * 1024)
    const { extractText } = await import('./extract')
    const text = await extractText(name, buf)
    return json(res, 200, { text, chars: text.length })
  }

  return json(res, 404, { error: 'Not found' })
}

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://local')
  const path = url.pathname
  if (path === '/health') return json(res, 200, { ok: true, version: VERSION, commit: BUILD?.commit ?? null })

  if (path === '/mcp' || path.startsWith('/mcp/')) {
    const agent = agentFor(req)
    if (!agent) return json(res, 401, { error: 'Missing or invalid Sidedoor agent token' })
    let profile = (path.slice(5) || 'app') as 'app' | 'browser' | 'story' | 'lookup' | 'grokbot'
    if (!['app', 'browser', 'story', 'lookup'].includes(profile)) return json(res, 404, { error: 'Unknown MCP endpoint' })
    // Grok Bot gets the app tools plus its task queue, and nothing else.
    if (agent === 'grokbot') {
      if (profile !== 'app') return json(res, 404, { error: 'Unknown MCP endpoint' })
      profile = 'grokbot'
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined
    const { handleMcp } = await import('../mcp/server')
    return handleMcp(req, res, profile, body)
  }

  if (path.startsWith('/api/')) return handleApi(req, res, path)

  if (path.startsWith('/files/')) {
    if (!isClient(req)) return json(res, 401, { error: 'Not signed in' })
    const f = inside(paths.files, path.slice('/files/'.length))
    if (!f) return json(res, 404, { error: 'Not found' })
    const download = url.searchParams.has('download')
    return sendFile(res, f, 'no-store', download ? { 'content-disposition': `attachment; filename="${f.split(sep).pop()}"` } : {})
  }

  // Dev: page loads go to Vite; it proxies /api, /mcp and /files back here.
  if (config.devUrl) {
    res.writeHead(302, { location: `${config.devUrl}${path}${url.search}` })
    return res.end()
  }

  // The web app. The bundle holds no data, so it's public; every data call is authorized.
  const root = paths.client
  const asset = path !== '/' ? inside(root, path) : null
  if (asset) return sendFile(res, asset, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache')
  const index = resolve(root, 'index.html')
  if (!existsSync(index)) return json(res, 503, { error: 'The web app is not built. Run `pnpm build`.' })
  return sendFile(res, index, 'no-cache')
}

export const startHttp = async () => {
  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[http]', req.method, req.url, e)
      if (!res.headersSent) json(res, 500, { error: e instanceof Error ? e.message : String(e) })
      else res.end()
    })
  })
  // Agents' tool calls can run for minutes (form fills, page reads).
  server.requestTimeout = 0
  server.headersTimeout = 60_000
  const listen = (port: number) =>
    new Promise<number>((ok, fail) => {
      server.once('error', fail)
      server.listen(port, config.host, () => {
        server.off('error', fail)
        const a = server.address()
        ok(typeof a === 'object' && a ? a.port : port)
      })
    })
  let port = config.port
  for (let i = 0; ; i++) {
    try {
      port = await listen(port)
      break
    } catch (e) {
      // The desktop app picks its port up front; `serve` scans upward from the default.
      if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE' || config.mode === 'desktop' || i > 20) throw e
      port++
    }
  }
  config.port = port
  const { runtimeFile } = await import('../mcp/bridge')
  writeFileSync(runtimeFile(), JSON.stringify({ port, pid: process.pid, version: VERSION, startedAt: new Date().toISOString() }))
  const cleanup = () => rmSync(runtimeFile(), { force: true })
  process.once('exit', cleanup)
  return { server, port, close: () => new Promise<void>((ok) => server.close(() => (cleanup(), ok()))) }
}
