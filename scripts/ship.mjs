#!/usr/bin/env node
/**
 * `pnpm ship`: build a commit into your everyday Sidedoor and restart it on that build (Linux).
 *
 * The everyday app runs from ~/Code/sidedoor-daily (SIDEDOOR_DAILY_DIR), never from a checkout you
 * edit, so work in progress can't break it. That folder has two build slots, `a` and `b` (git
 * worktrees), and `current` points at the live one. A ship builds the spare slot, runs the
 * typecheck and tests there, backs up your data, switches `current`, restarts the app and checks
 * that the new build answers. If it doesn't, it switches back. Your data stays in ~/.sidedoor.
 *
 *   pnpm ship [ref]                   ship a commit (default: HEAD of this checkout)
 *   pnpm ship --no-checks [ref]       skip the typecheck and tests
 *   pnpm ship --rollback              go back to the previous build (kept in the other slot)
 *   pnpm ship --rollback --restore-data
 *                                     ...and put back the data backup taken just before the bad
 *                                     build went live (changes made since are kept in
 *                                     userdata/backups/replaced-*.sqlite)
 *   pnpm ship --status                what's live, what's in the other slot
 *
 * The app runs as the user service `sidedoor` (a transient systemd unit started by the launcher
 * script ~/Code/sidedoor-daily/sidedoor, which the app menu entry and login autostart also use).
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const daily = resolve(process.env.SIDEDOOR_DAILY_DIR ?? resolve(homedir(), 'Code/sidedoor-daily'))
const userdata = resolve(homedir(), '.sidedoor/userdata')
const dbFile = resolve(userdata, 'sidedoor.sqlite')
const backups = resolve(userdata, 'backups')
const stateFile = resolve(daily, 'state.json')
const launcher = resolve(daily, 'sidedoor')
const UNIT = 'sidedoor.service'
const KEEP_BACKUPS = 20

const args = process.argv.slice(2)
const flag = (f) => args.includes(f)
const ref = args.find((a) => !a.startsWith('--')) ?? 'HEAD'

const say = (s) => console.log(`[ship] ${s}`)
const fail = (s) => {
  console.error(`[ship] ${s}`)
  process.exit(1)
}
const sh = (cmd, a, o = {}) => execFileSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...o }).trim()
/** Runs quietly; on failure prints the end of what it said. */
const step = (cmd, a, o = {}) => {
  const r = spawnSync(cmd, a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...o })
  if (r.status !== 0) {
    console.error(`${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-60).join('\n'))
    throw new Error(`${cmd} ${a.join(' ')} failed`)
  }
}
const git = (a, cwd = root) => sh('git', a, { cwd })

if (process.platform !== 'linux') fail('pnpm ship sets up the everyday app on Linux only for now.')

// --- state --------------------------------------------------------------------------------

/** { current: 'a' | 'b' | null, slots: { a?: Slot, b?: Slot } }, Slot = { commit, subject, builtAt, backup } */
const readState = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { current: null, slots: {} })
const writeState = (s) => writeFileSync(stateFile, `${JSON.stringify(s, null, 2)}\n`)
const other = (slot) => (slot === 'a' ? 'b' : 'a')
const slotDir = (slot) => resolve(daily, slot)

/** Point `current` at a slot, atomically (a new symlink renamed over the old one). */
const pointAt = (slot) => {
  const tmp = resolve(daily, `.current-${process.pid}`)
  rmSync(tmp, { force: true })
  symlinkSync(slot, tmp)
  renameSync(tmp, resolve(daily, 'current'))
}

// --- the running app ----------------------------------------------------------------------

const active = () => spawnSync('systemctl', ['--user', '-q', 'is-active', UNIT]).status === 0

const runningTasks = () => {
  try {
    const d = new DatabaseSync(dbFile, { readOnly: true })
    const n = d.prepare("select count(*) as n from tasks where status = 'running'").get().n
    d.close()
    return n
  } catch {
    return 0
  }
}

const stopApp = () => {
  if (!active()) return
  spawnSync('systemctl', ['--user', 'stop', UNIT], { stdio: 'inherit' })
}

const startApp = () => {
  // Through the launcher, so the app gets the same environment as from the app menu.
  const r = spawnSync(launcher, [], { stdio: 'inherit', env: cleanEnv() })
  if (r.status !== 0) throw new Error('the launcher failed')
}

/** This shell may run inside another Electron app or AppImage; none of that should leak in. */
const cleanEnv = () => {
  const env = { ...process.env }
  for (const k of ['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD', 'ELECTRON_RUN_AS_NODE', 'SIDEDOOR_HOME', 'SIDEDOOR_PORT', 'SIDEDOOR_NO_JOBS']) delete env[k]
  return env
}

/** Wait until the app's server answers with the expected commit. */
const waitFor = async (commit, since, timeoutMs = 90_000) => {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000))
    try {
      const rt = JSON.parse(readFileSync(resolve(userdata, 'server-runtime.json'), 'utf8'))
      if (new Date(rt.startedAt).getTime() < since) continue
      const h = await (await fetch(`http://127.0.0.1:${rt.port}/health`, { signal: AbortSignal.timeout(2000) })).json()
      if (h.ok && h.commit === commit) return true
    } catch {
      // not up yet
    }
  }
  return false
}

const restartOn = async (commit) => {
  const busy = runningTasks()
  if (busy) say(`${busy} AI task${busy === 1 ? ' was' : 's were'} running; ${busy === 1 ? 'it starts' : 'they start'} again after the restart.`)
  const since = Date.now()
  stopApp()
  startApp()
  return waitFor(commit, since)
}

const showLog = () => {
  spawnSync('journalctl', ['--user', '-u', UNIT, '-n', '40', '--no-pager', '-o', 'cat'], { stdio: 'inherit' })
}

// --- files the desktop uses ---------------------------------------------------------------

const writeLauncher = () => {
  const app = resolve(daily, 'current/apps/desktop')
  const electron = resolve(app, 'node_modules/electron/dist/electron')
  writeFileSync(
    launcher,
    `#!/bin/sh
# Opens your everyday Sidedoor (the build in ${daily}/current). Written by pnpm ship.
export SIDEDOOR_SOURCE_INSTALL=1 SIDEDOOR_LAUNCHER="${launcher}"
unset APPIMAGE APPDIR ARGV0 OWD ELECTRON_RUN_AS_NODE SIDEDOOR_HOME
if systemctl --user -q is-active ${UNIT}; then
  # Already running: this second copy shows the open window and quits.
  exec "${electron}" "${app}" "$@"
fi
systemctl --user reset-failed ${UNIT} 2>/dev/null
exec systemd-run --user --unit=${UNIT} --collect -q -p Restart=on-failure -p RestartSec=5 -p TimeoutStopSec=20 \\
  --setenv=SIDEDOOR_SOURCE_INSTALL=1 --setenv=SIDEDOOR_LAUNCHER="${launcher}" --setenv=PATH="$PATH" \\
  "${electron}" "${app}" "$@"
`,
    { mode: 0o755 },
  )
  const apps = resolve(homedir(), '.local/share/applications')
  mkdirSync(apps, { recursive: true })
  writeFileSync(
    resolve(apps, 'sidedoor.desktop'),
    `[Desktop Entry]\nType=Application\nName=Sidedoor\nComment=Your job search, run by your AI\nExec="${launcher}"\nIcon=${resolve(app, 'resources/icon.png')}\nTerminal=false\nCategories=Office;\nStartupWMClass=Sidedoor\n`,
  )
}

// --- data backups -------------------------------------------------------------------------

const backup = (label) => {
  if (!existsSync(dbFile)) return null
  mkdirSync(backups, { recursive: true })
  const dest = resolve(backups, `ship-${new Date().toISOString().replace(/[:.]/g, '-')}-${label}.sqlite`)
  const d = new DatabaseSync(dbFile, { readOnly: true })
  d.exec(`vacuum into '${dest.replace(/'/g, "''")}'`)
  d.close()
  for (const f of readdirSync(backups).filter((f) => f.startsWith('ship-')).sort().slice(0, -KEEP_BACKUPS)) rmSync(resolve(backups, f), { force: true })
  return dest
}

/** Swap the live database for a backup. The app must be stopped. */
const restoreData = (from) => {
  const keep = resolve(backups, `replaced-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
  const d = new DatabaseSync(dbFile)
  d.exec(`vacuum into '${keep.replace(/'/g, "''")}'`)
  d.close()
  for (const s of ['-wal', '-shm']) rmSync(`${dbFile}${s}`, { force: true })
  copyFileSync(from, `${dbFile}.restoring`)
  renameSync(`${dbFile}.restoring`, dbFile)
  say(`data restored from ${from}; what it replaced is in ${keep}`)
}

// --- one ship at a time -------------------------------------------------------------------

const lockFile = resolve(daily, '.ship.lock')
const lock = () => {
  mkdirSync(daily, { recursive: true })
  if (existsSync(lockFile)) {
    const pid = Number(readFileSync(lockFile, 'utf8'))
    let alive = false
    try {
      process.kill(pid, 0)
      alive = true
    } catch {}
    if (alive) fail(`another ship is running (pid ${pid}).`)
  }
  writeFileSync(lockFile, String(process.pid))
  process.on('exit', () => rmSync(lockFile, { force: true }))
}

// --- commands -----------------------------------------------------------------------------

const describe = (slot, s) => (s ? `${slot}: ${s.commit.slice(0, 7)} ${s.subject} (built ${new Date(s.builtAt).toLocaleString()})` : `${slot}: empty`)

const status = () => {
  const s = readState()
  if (!s.current) return say(`nothing shipped yet (${daily})`)
  say(`live      ${describe(s.current, s.slots[s.current])}`)
  say(`previous  ${describe(other(s.current), s.slots[other(s.current)])}`)
  say(`app ${active() ? 'running' : 'not running'}`)
}

const rollback = async () => {
  const s = readState()
  const back = s.current && other(s.current)
  if (!back || !s.slots[back]) fail('there is no previous build to go back to.')
  const bad = s.slots[s.current]
  say(`going back to ${describe(back, s.slots[back])}`)
  stopApp()
  if (flag('--restore-data')) {
    if (!bad?.backup || !existsSync(bad.backup)) fail('no backup was recorded for the current build; data left as is.')
    restoreData(bad.backup)
  }
  pointAt(back)
  writeState({ ...s, current: back })
  writeLauncher()
  if (!(await restartOn(s.slots[back].commit))) {
    showLog()
    fail('the previous build did not come up either; see the log above.')
  }
  say('done.')
}

const ship = async () => {
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`])
  const subject = git(['log', '-1', '--format=%s', commit])
  if (ref === 'HEAD' && git(['status', '--porcelain', '--untracked-files=no'])) say('note: uncommitted changes in this checkout are not shipped, only the commit.')
  const s = readState()
  if (s.current && s.slots[s.current]?.commit === commit && !flag('--force')) {
    say(`${commit.slice(0, 7)} is already live. (--force to rebuild it.)`)
    return
  }

  // Build the slot that isn't live.
  const slot = s.current ? other(s.current) : 'a'
  const dir = slotDir(slot)
  say(`building ${commit.slice(0, 7)} ${subject} into slot ${slot}`)
  if (!existsSync(dir)) git(['worktree', 'add', '-q', '--detach', dir, commit])
  else {
    if (git(['status', '--porcelain', '--untracked-files=no'], dir)) fail(`${dir} has local changes; it should only ever be built, not edited.`)
    git(['checkout', '-q', '--detach', commit], dir)
  }
  try {
    step('pnpm', ['install', '--frozen-lockfile', '--prefer-offline', '--reporter=silent'], { cwd: dir })
    // pnpm can skip Electron's download in a new checkout (its install script is cached as done);
    // run it directly. It reuses ~/.cache/electron, so this takes a second.
    const desktop = resolve(dir, 'apps/desktop')
    if (!existsSync(resolve(desktop, 'node_modules/electron/dist/electron'))) step(process.execPath, ['node_modules/electron/install.js'], { cwd: desktop })
    if (!flag('--no-checks')) {
      say('typecheck and tests')
      step('pnpm', ['-s', 'typecheck'], { cwd: dir })
      step('pnpm', ['-s', 'test'], { cwd: dir })
    }
    say('build')
    step('pnpm', ['-s', 'build:desktop'], { cwd: dir, env: { ...process.env, SIDEDOOR_BUILD_COMMIT: commit } })
    for (const f of ['apps/desktop/dist-electron/main.cjs', 'apps/server/dist/bin.mjs', 'apps/server/dist/client/index.html', 'apps/desktop/node_modules/electron/dist/electron'])
      if (!existsSync(resolve(dir, f))) throw new Error(`the build has no ${f}`)
    // A sandboxed preload can load only `electron`; anything else and the app loses its desktop bridge.
    const preloadRequires = readFileSync(resolve(dir, 'apps/desktop/dist-electron/preload.cjs'), 'utf8').match(/require\(([^)]*)\)/g) ?? []
    if (preloadRequires.some((r) => !/^require\(["']electron["']\)$/.test(r))) throw new Error(`the desktop preload loads more than electron (${preloadRequires.join(', ')})`)
  } catch (e) {
    fail(`${e.message}. Nothing changed: the live app is untouched.`)
  }

  const saved = backup(commit.slice(0, 7))
  if (saved) say(`data backed up to ${saved}`)
  const prev = s.current
  pointAt(slot)
  const next = { current: slot, slots: { ...s.slots, [slot]: { commit, subject, builtAt: new Date().toISOString(), backup: saved } } }
  writeState(next)
  writeLauncher()
  say(prev ? 'restarting Sidedoor' : 'starting Sidedoor')
  if (await restartOn(commit)) {
    say(`live: ${commit.slice(0, 7)} ${subject}`)
    return
  }
  showLog()
  if (!prev) fail('the new build did not come up; see the log above.')
  say('the new build did not come up; going back to the previous one')
  stopApp()
  pointAt(prev)
  writeState({ ...next, current: prev })
  writeLauncher()
  if (!(await restartOn(s.slots[prev].commit))) fail('the previous build did not come up either; see the log above.')
  fail(`back on ${s.slots[prev].commit.slice(0, 7)}. The failed build stays in slot ${slot} to look at.`)
}

if (flag('--status')) status()
else {
  lock()
  await (flag('--rollback') ? rollback() : ship())
}
