#!/usr/bin/env node
// `pnpm dev`: the server (with a dev home in .sidedoor-dev) and Vite, together. Vite proxies the
// server's paths, so open the Vite URL; the sign-in link is printed once the server is up. Each
// checkout picks free ports, so several can run next to each other and next to the desktop app.
// Ctrl+C stops both.
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const free = (port) =>
  new Promise((done) => {
    const s = createServer()
    s.once('error', () => done(false))
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)))
  })
const pick = async (start) => {
  for (let p = start; p < start + 50; p++) if (await free(p)) return String(p)
  throw new Error(`No free port from ${start}`)
}

// The desktop app takes ports from 4848 up; dev servers start above its range.
const port = process.env.SIDEDOOR_PORT ?? (await pick(4950))
const webPort = process.env.SIDEDOOR_WEB_PORT ?? (await pick(5848))
const home = process.env.SIDEDOOR_HOME ?? resolve(root, '.sidedoor-dev')
const env = { ...process.env, SIDEDOOR_PORT: port, SIDEDOOR_WEB_PORT: webPort, SIDEDOOR_DEV_SERVER: `http://127.0.0.1:${port}`, SIDEDOOR_HOME: home }
const serverDir = resolve(root, 'apps/server')

let linked = false
const run = (name, cmd, args, cwd) => {
  const p = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' })
  const tag = (d) =>
    d
      .toString()
      .split('\n')
      .filter(Boolean)
      .forEach((l) => {
        console.log(`[${name}] ${l}`)
        if (name === 'server' && !linked && l.includes('listening on')) {
          linked = true
          const pair = execFileSync(process.execPath, ['--import', 'tsx', 'src/bin.ts', 'pair'], { cwd: serverDir, env, encoding: 'utf8' }).trim()
          console.log(`\n  Open ${pair.replace(`:${port}/`, `:${webPort}/`)}\n  (data: ${home})\n`)
        }
      })
  p.stdout.on('data', tag)
  p.stderr.on('data', tag)
  return p
}
const procs = [
  run('server', process.execPath, ['--watch', '--watch-path=src', '--watch-path=../../packages/shared/src', '--import', 'tsx', 'src/bin.ts', 'serve', '--dev', '--port', port], serverDir),
  run('web', 'pnpm', ['exec', 'vite', '--host', '127.0.0.1', '--port', webPort], resolve(root, 'apps/web')),
]
const stop = () => {
  for (const p of procs) p.kill('SIGTERM')
  process.exit(0)
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
