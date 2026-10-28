import { spawn } from 'node:child_process'
import { config } from './config'
import { startHttp } from './http/server'
import { normalizeStages, startJobs } from './jobs/runner'
import { startLiveChanges } from './live'
import { VERSION } from './version'

const openBrowser = (url: string) => {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]]
  spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
}

/** Boot order: database (on import) → HTTP → live change feed → background jobs → AI probes. */
export const startServer = async (o: { open: boolean }) => {
  const { db } = await import('./db/client')
  void db
  const http = await startHttp()
  startLiveChanges()
  normalizeStages()
  // SIDEDOOR_NO_JOBS=1: serve data without polling boards or running AI jobs (inspecting a copy).
  const stopJobs = process.env.SIDEDOOR_NO_JOBS === '1' ? async () => {} : startJobs()
  // Probe the AI CLIs in the background so Settings opens with their status ready.
  void import('./ai').then((ai) => ai.providerStatuses(true)).catch(() => {})
  const { accessToken } = await import('./http/auth')
  const url = `http://127.0.0.1:${http.port}`
  console.log(`[sidedoor] ${VERSION} listening on ${config.host}:${http.port} (home ${config.home})`)
  if (config.mode === 'web' && !config.devUrl) {
    const pair = `${url}/pair#token=${accessToken()}`
    console.log(`[sidedoor] open ${pair}`)
    if (o.open) openBrowser(pair)
  }
  // Desktop readiness signal (the desktop app also polls /health).
  if (config.mode === 'desktop') console.log(`SIDEDOOR_READY ${http.port}`)
  let stopping = false
  const shutdown = async () => {
    if (stopping) return
    stopping = true
    console.log('[sidedoor] shutting down')
    // Agents we started must not outlive us: their task is requeued on the next start.
    ;(await import('./ai/util')).killAllAgents()
    await Promise.race([Promise.all([stopJobs(), http.close()]), new Promise((r) => setTimeout(r, 4000))])
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  // The desktop app closes our stdin when it quits; don't outlive it.
  if (config.mode === 'desktop') process.stdin.on('end', shutdown).resume()
}
