#!/usr/bin/env node
/**
 * Launch the packaged desktop app (release/dist/*-unpacked) with an empty data folder and check it
 * comes up: the server answers, the web app is served, data calls need auth, the MCP endpoint
 * needs a token, and the MCP bridge runtime was copied. Used by CI on every OS.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const dist = resolve(import.meta.dirname, '../release/dist')
const candidates = {
  linux: [join(dist, 'linux-unpacked/sidedoor')],
  darwin: readdirSync(dist).filter((d) => d.startsWith('mac')).map((d) => join(dist, d, 'Sidedoor.app/Contents/MacOS/Sidedoor')),
  win32: [join(dist, 'win-unpacked/Sidedoor.exe')],
}[process.platform]
const exe = candidates.find(existsSync)
if (!exe) throw new Error(`No packaged app in ${dist}`)

const home = mkdtempSync(join(tmpdir(), 'sidedoor-smoke-'))
const port = 4890 + Math.floor(Math.random() * 50)
const env = { ...process.env, SIDEDOOR_HOME: home, SIDEDOOR_PORT: String(port), SIDEDOOR_DISABLE_AUTO_UPDATE: '1' }
delete env.ELECTRON_RUN_AS_NODE
// On Linux, run on a virtual display whenever there is one, so a local run never pops a window.
const hasXvfb = process.platform === 'linux' && ['/usr/bin/xvfb-run', '/bin/xvfb-run'].some(existsSync)
const headlessLinux = process.platform === 'linux' && (hasXvfb || !process.env.DISPLAY)
if (headlessLinux) {
  delete env.WAYLAND_DISPLAY
  delete env.DISPLAY
}
const [cmd, args] = headlessLinux ? ['xvfb-run', ['-a', exe, '--no-sandbox', '--ozone-platform=x11']] : [exe, process.platform === 'linux' ? ['--no-sandbox', '--ozone-platform=x11'] : []]
console.log(`launching ${exe} (home ${home}, port ${port})`)
// Its own process group, so cleanup stops xvfb-run, Xvfb and the app together.
const app = spawn(cmd, args, { env, stdio: 'inherit', detached: process.platform !== 'win32' })
const stop = () => {
  try {
    if (process.platform === 'win32') app.kill()
    else process.kill(-app.pid, 'SIGTERM')
  } catch {}
}

const base = `http://127.0.0.1:${port}`
const until = Date.now() + 90_000
const check = (ok, what) => {
  if (!ok) throw new Error(`smoke: ${what}`)
  console.log(`ok  ${what}`)
}
let code = 0
try {
  for (;;) {
    try {
      if ((await fetch(`${base}/health`)).ok) break
    } catch {}
    if (Date.now() > until) throw new Error('the server never answered /health')
    await new Promise((r) => setTimeout(r, 500))
  }
  check(true, 'server is up')
  const page = await (await fetch(`${base}/welcome`)).text()
  check(page.includes('<div id="root">'), 'web app is served')
  check((await fetch(`${base}/api/rpc/settings`, { method: 'POST', body: '{}' })).status === 401, 'data calls need auth')
  check((await fetch(`${base}/mcp`, { method: 'POST', body: '{}' })).status === 401, 'MCP needs a token')
  const runtime = join(home, 'runtime')
  check(existsSync(runtime) && readdirSync(runtime).some((v) => existsSync(join(runtime, v, 'dist', 'bin.mjs'))), 'MCP bridge runtime copied')
  check(existsSync(join(home, 'userdata', 'sidedoor.sqlite')), 'database created')
} catch (e) {
  console.error(e instanceof Error ? e.message : e)
  code = 1
} finally {
  stop()
  await new Promise((r) => setTimeout(r, 3000))
  rmSync(home, { recursive: true, force: true })
  process.exit(code)
}
