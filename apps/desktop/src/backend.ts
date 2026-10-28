import { type ChildProcess, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mcpCommand, serverEntry, serverRoot, sidedoorHome } from './paths'

/**
 * The server runs as a child process: this app's own binary with ELECTRON_RUN_AS_NODE, so users
 * need no Node install (T3 Code does the same). Its bootstrap (port, token, bridge) goes over fd 3,
 * never argv or env, and it restarts with backoff if it dies.
 */
export interface Backend {
  port: number
  token: string
  url: string
  stop: () => Promise<void>
}

const portFree = (port: number) =>
  new Promise<boolean>((ok) => {
    const s = createServer()
    s.once('error', () => ok(false))
    s.listen(port, '127.0.0.1', () => s.close(() => ok(true)))
  })

/** The default port, or the next free one. Stable across launches so links keep working. */
export const pickPort = async (start = 4848) => {
  for (let p = start; p < start + 50; p++) if (await portFree(p)) return p
  throw new Error('No free port for Sidedoor')
}

const waitHealthy = async (url: string, timeoutMs = 60_000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1000) })
      if (r.ok) return
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('Sidedoor did not start in time')
}

export const startBackend = async (o: { port: number; token: string; host: string; bridge: { url: string; token: string }; onLog: (line: string) => void; onExit?: (code: number | null) => void }): Promise<Backend> => {
  const url = `http://127.0.0.1:${o.port}`
  let child: ChildProcess | null = null
  let stopping = false
  let backoff = 500

  const launch = () => {
    const bootstrap = JSON.stringify({ home: sidedoorHome(), port: o.port, host: o.host, token: o.token, bridge: o.bridge })
    child = spawn(process.execPath, [serverEntry(), 'serve', '--bootstrap-fd', '3'], {
      cwd: serverRoot(),
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        SIDEDOOR_RESOURCES: serverRoot(),
        SIDEDOOR_MCP_COMMAND: JSON.stringify(mcpCommand()),
      },
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const fd3 = child.stdio[3] as NodeJS.WritableStream
    fd3.end(`${bootstrap}\n`)
    const log = (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(o.onLog)
    child.stdout?.on('data', log)
    child.stderr?.on('data', log)
    child.on('exit', (code) => {
      o.onExit?.(code)
      child = null
      if (stopping) return
      o.onLog(`[desktop] server exited (${code}); restarting in ${backoff}ms`)
      setTimeout(launch, backoff)
      backoff = Math.min(backoff * 2, 10_000)
    })
  }

  launch()
  await waitHealthy(url)
  backoff = 500

  return {
    port: o.port,
    token: o.token,
    url,
    stop: async () => {
      stopping = true
      const c = child
      if (!c) return
      await new Promise<void>((done) => {
        const t = setTimeout(() => {
          c.kill('SIGKILL')
          done()
        }, 5000)
        c.once('exit', () => {
          clearTimeout(t)
          done()
        })
        // Closing stdin asks the server to shut down cleanly (it also handles SIGTERM).
        c.stdin?.end()
        c.kill('SIGTERM')
      })
    },
  }
}
