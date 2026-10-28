// Copy the built web app next to the server bundle, so `sidedoor serve` serves it.
import { cpSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const here = import.meta.dirname
const from = resolve(here, '../../web/dist')
const to = resolve(here, '../dist/client')
if (!existsSync(resolve(from, 'index.html'))) {
  console.warn('[copy-client] apps/web/dist is missing; build the web app first')
  process.exit(0)
}
rmSync(to, { recursive: true, force: true })
cpSync(from, to, { recursive: true })
console.log('[copy-client] web app copied to dist/client')
