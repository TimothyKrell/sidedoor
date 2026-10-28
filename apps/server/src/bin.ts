import { readFileSync } from 'node:fs'
import { type Bootstrap, initConfig } from './config'

/**
 * Sidedoor's command line.
 *
 *   sidedoor serve [--port 4848] [--host 127.0.0.1] [--home ~/.sidedoor] [--no-open]
 *   sidedoor mcp [story|lookup]        stdio MCP bridge for your own AI CLI
 *   sidedoor pair                      print a link that signs a browser in
 *   sidedoor import-legacy <dir>       one-time import from a pre-1.0 Sidedoor checkout
 *
 * The desktop app runs `serve --bootstrap-fd 3` and writes its bootstrap JSON to fd 3.
 */
const argv = process.argv.slice(2)
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'serve'
const flag = (name: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : undefined
}
const has = (name: string) => argv.includes(`--${name}`)

const readBootstrap = (): Bootstrap => {
  const fd = flag('bootstrap-fd') ?? process.env.SIDEDOOR_BOOTSTRAP_FD
  if (fd) return { mode: 'desktop', ...(JSON.parse(readFileSync(Number(fd), 'utf8')) as Omit<Bootstrap, 'mode'>) }
  const port = flag('port')
  const home = flag('home')
  const host = flag('host')
  return {
    mode: 'web',
    ...(port ? { port: Number(port) } : {}),
    ...(home ? { home } : {}),
    ...(host ? { host } : {}),
    ...(has('dev') ? { devUrl: process.env.SIDEDOOR_DEV_URL ?? 'http://localhost:5848', home: home ?? process.env.SIDEDOOR_HOME ?? `${process.cwd()}/../../.sidedoor-dev` } : {}),
  }
}

const main = async () => {
  if (cmd === 'mcp') {
    initConfig({ mode: 'web', ...(flag('home') ? { home: flag('home')! } : {}) })
    const { runBridge } = await import('./mcp/bridge')
    return runBridge(argv[1] && !argv[1].startsWith('-') ? argv[1] : '')
  }
  const boot = initConfig(readBootstrap())
  if (cmd === 'pair') {
    const { accessToken } = await import('./http/auth')
    console.log(`http://127.0.0.1:${boot.port}/pair#token=${accessToken()}`)
    return
  }
  if (cmd === 'import-legacy') {
    const { importLegacy } = await import('./legacy/import')
    const dir = argv[1]
    if (!dir) throw new Error('usage: sidedoor import-legacy <old sidedoor checkout> [--resume-dir ~/Code/resume]')
    await importLegacy({ from: dir, resumeDir: flag('resume-dir') ?? null })
    return
  }
  if (cmd !== 'serve') throw new Error(`Unknown command ${cmd}`)
  const { startServer } = await import('./main')
  await startServer({ open: boot.mode === 'web' && !has('no-open') && !boot.devUrl })
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
