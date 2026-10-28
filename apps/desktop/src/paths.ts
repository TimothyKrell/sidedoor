import { app } from 'electron'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * A checkout built and run as someone's everyday install (`pnpm ship`): the real data home and
 * profile, like an installed app, but no auto-update (updates come from the checkout).
 */
export const isSourceInstall = !app.isPackaged && process.env.SIDEDOOR_SOURCE_INSTALL === '1'
export const isDev = !app.isPackaged && !isSourceInstall

const defaultHome = () => join(homedir(), '.sidedoor')

/** Sidedoor's data home (same default as `sidedoor serve`), separate in dev. */
export const sidedoorHome = () =>
  process.env.SIDEDOOR_HOME ? resolve(process.env.SIDEDOOR_HOME) : isDev ? resolve(__dirname, '../../../.sidedoor-dev') : defaultHome()

/**
 * The Electron profile (and with it the one-window lock) belongs to the data home: the default
 * home uses the usual profile, any other home (a dev checkout, a trial copy) gets its own inside
 * it, so two homes can run side by side.
 */
export const profileDir = () => (sidedoorHome() === defaultHome() ? null : join(sidedoorHome(), 'electron-profile'))

/** The server bundle: resources/server in a packaged app, apps/server in the repo. */
export const serverRoot = () => (app.isPackaged ? join(process.resourcesPath, 'server') : resolve(__dirname, '../../server'))
export const serverEntry = () => join(serverRoot(), 'dist', 'bin.mjs')

export const iconPath = () => {
  const p = app.isPackaged ? join(process.resourcesPath, 'icon.png') : resolve(__dirname, '../resources/icon.png')
  return existsSync(p) ? p : undefined
}
export const trayIconPath = () => {
  const name = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'
  const p = app.isPackaged ? join(process.resourcesPath, name) : resolve(__dirname, '../resources', name)
  return existsSync(p) ? p : iconPath()
}

/**
 * How the user's own AI CLIs launch the MCP bridge: this app's executable as plain Node
 * (ELECTRON_RUN_AS_NODE, so no display is needed, e.g. over SSH) running a copy of the server
 * bundle kept in the data home. The registered path is a small launcher that never moves
 * (runtime/bridge.mjs); it loads whichever version is current, so updates don't break the user's
 * AI configs. The copy matters for AppImages, whose files live on a temporary mount.
 */
const runtimeRoot = () => join(sidedoorHome(), 'runtime')
export const runtimeDir = () => join(runtimeRoot(), app.getVersion())
/**
 * An AppImage's file name carries its version and the updater replaces the file, and a source
 * install switches between build folders, so AI configs point at a small script instead,
 * rewritten with the current executable on every launch.
 */
const appImageShim = () => join(runtimeRoot(), 'sidedoor-mcp')
/** Our own AppImage, not one we were merely launched from (APPIMAGE is inherited by child processes). */
export const appImage = () => (process.env.APPIMAGE && process.env.APPDIR && process.execPath.startsWith(process.env.APPDIR) ? process.env.APPIMAGE : null)
/** What the MCP shim runs: the AppImage, or this build's Electron for a source install. */
const shimTarget = () => appImage() ?? (isSourceInstall ? process.execPath : null)
export const mcpCommand = () => ({
  command: shimTarget() ? appImageShim() : process.execPath,
  args: shimTarget() ? [] : [join(runtimeRoot(), 'bridge.mjs'), 'mcp'],
  env: { ELECTRON_RUN_AS_NODE: '1', ...(process.env.SIDEDOOR_HOME ? { SIDEDOOR_HOME: sidedoorHome() } : {}) } as Record<string, string>,
})

const LAUNCHER = `// Written by the Sidedoor desktop app. Loads the current version of the MCP bridge.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const here = dirname(fileURLToPath(import.meta.url))
const version = readFileSync(join(here, 'current'), 'utf8').trim()
await import(pathToFileURL(join(here, version, 'dist', 'bin.mjs')).href)
`

/** Keep the runtime copy current; keep the previous version too, in case a bridge is still running from it. */
export const ensureRuntime = () => {
  const root = runtimeRoot()
  const dest = runtimeDir()
  mkdirSync(root, { recursive: true })
  // Unpackaged builds change without a version bump: copy every launch.
  if (!existsSync(join(dest, 'dist', 'bin.mjs')) || !app.isPackaged) {
    // The bridge needs only the bundle (no web app, no Playwright).
    cpSync(join(serverRoot(), 'dist'), join(dest, 'dist'), { recursive: true, filter: (p) => !p.includes(join('dist', 'client')) && !p.endsWith('.map') })
    writeFileSync(join(dest, 'package.json'), '{"type":"module"}\n')
  }
  const previous = existsSync(join(root, 'current')) ? readFileSync(join(root, 'current'), 'utf8').trim() : null
  writeFileSync(join(root, 'bridge.mjs'), LAUNCHER)
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'current'), app.getVersion())
  const image = shimTarget()
  if (image) {
    const q = (x: string) => `'${x.replace(/'/g, `'\\''`)}'`
    writeFileSync(appImageShim(), `#!/bin/sh\n# Written by the Sidedoor desktop app on each launch.\nELECTRON_RUN_AS_NODE=1 exec ${q(image)} ${q(join(root, 'bridge.mjs'))} mcp "$@"\n`)
    chmodSync(appImageShim(), 0o755)
  }
  for (const v of readdirSync(root)) {
    if (v === app.getVersion() || v === previous || !/^\d/.test(v)) continue
    rmSync(join(root, v), { recursive: true, force: true })
  }
}
