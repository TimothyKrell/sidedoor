import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Process-level configuration. Everything a user can change lives in the settings table and is
 * edited in the app; this is only where things are and how to reach them.
 *
 * The desktop app passes a bootstrap object on fd 3 (see apps/desktop/src/backend.ts); `sidedoor
 * serve` builds one from flags and env. `initConfig` must run before anything opens the database.
 */
export interface Bootstrap {
  mode: 'desktop' | 'web'
  home?: string
  port?: number
  host?: string
  /** Bearer/cookie token every client must present. Generated when absent. */
  token?: string
  /** Desktop bridge for PDFs, browser windows and notifications. */
  bridge?: { url: string; token: string }
  /** Dev: where the Vite dev server runs; the server redirects page loads there. */
  devUrl?: string
}

const expand = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? resolve(homedir(), p.slice(2)) : resolve(p))

/** Where prompts/, drizzle/ and defaults/ live: apps/server in dev, next to dist/ when bundled. */
const here = dirname(fileURLToPath(import.meta.url))
const resourceDir = process.env.SIDEDOOR_RESOURCES ? expand(process.env.SIDEDOOR_RESOURCES) : resolve(here, '..')

let boot: Required<Pick<Bootstrap, 'mode' | 'home' | 'port' | 'host' | 'token'>> & Pick<Bootstrap, 'bridge' | 'devUrl'>

export const initConfig = (b: Bootstrap) => {
  boot = {
    mode: b.mode,
    home: expand(b.home ?? process.env.SIDEDOOR_HOME ?? '~/.sidedoor'),
    port: b.port ?? Number(process.env.SIDEDOOR_PORT ?? 4848),
    host: b.host ?? process.env.SIDEDOOR_HOST ?? '127.0.0.1',
    token: b.token ?? process.env.SIDEDOOR_TOKEN ?? randomBytes(24).toString('base64url'),
    ...(b.bridge ? { bridge: b.bridge } : {}),
    ...(b.devUrl ? { devUrl: b.devUrl } : {}),
  }
  return boot
}

const get = () => {
  // Tests and scripts that import services directly get a default web-mode config.
  if (!boot) initConfig({ mode: 'web' })
  return boot
}

export const config = {
  get mode() {
    return get().mode
  },
  get home() {
    return get().home
  },
  get port() {
    return get().port
  },
  set port(p: number) {
    get().port = p
  },
  get host() {
    return get().host
  },
  get token() {
    return get().token
  },
  get bridge() {
    return get().bridge
  },
  get devUrl() {
    return get().devUrl
  },
  /** Base URL of this server as the user's own machine sees it. */
  get localUrl() {
    return `http://127.0.0.1:${get().port}`
  },
}

const ensure = (p: string) => {
  mkdirSync(p, { recursive: true })
  return p
}

export const paths = {
  get state() {
    return ensure(resolve(config.home, 'userdata'))
  },
  get db() {
    return resolve(paths.state, 'sidedoor.sqlite')
  },
  get backups() {
    return ensure(resolve(paths.state, 'backups'))
  },
  /** Generated PDFs, uploads, attachments. Served under /files/. */
  get files() {
    return ensure(resolve(paths.state, 'files'))
  },
  get secrets() {
    return ensure(resolve(paths.state, 'secrets'))
  },
  get logs() {
    return ensure(resolve(paths.state, 'logs'))
  },
  /** Empty per-task working directories for agents. Never a user folder. */
  get jobs() {
    return ensure(resolve(paths.state, 'jobs'))
  },
  get browserProfile() {
    return ensure(resolve(paths.state, 'browser'))
  },
  prompts: resolve(resourceDir, 'prompts'),
  migrations: resolve(resourceDir, 'drizzle'),
  defaults: resolve(resourceDir, 'defaults'),
  /** The built web app, served at /. */
  get client() {
    const candidates = [resolve(resourceDir, 'dist/client'), resolve(resourceDir, '../web/dist')]
    return candidates.find((c) => existsSync(resolve(c, 'index.html'))) ?? candidates[0]!
  },
}

/** Find an executable on PATH (with Windows extensions). */
export const findOnPath = (bin: string): string | undefined => {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').concat('') : ['']
  const extra = [resolve(homedir(), '.local/bin'), resolve(homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin']
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...extra]) {
    if (!dir) continue
    for (const ext of exts) {
      const p = resolve(dir, bin + ext.toLowerCase())
      if (existsSync(p)) return p
      const q = resolve(dir, bin + ext)
      if (existsSync(q)) return q
    }
  }
  return undefined
}
