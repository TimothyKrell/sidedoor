#!/usr/bin/env node
/**
 * `pnpm dev:data`: replace this checkout's dev data (.sidedoor-dev) with a copy of your real data
 * (~/.sidedoor, or SIDEDOOR_SOURCE_HOME), so `pnpm dev` shows a change against what you actually
 * have. The copy only reads the real home, and it is made quiet: no scout, no daily AI jobs, no
 * automatic prep or research, no notifications. AI work you start yourself still runs.
 *
 *   pnpm dev:data            (stop `pnpm dev` in this checkout first)
 */
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const root = resolve(import.meta.dirname, '..')
const from = resolve(process.env.SIDEDOOR_SOURCE_HOME ?? resolve(homedir(), '.sidedoor'), 'userdata')
const home = resolve(process.env.SIDEDOOR_HOME ?? resolve(root, '.sidedoor-dev'))
const to = resolve(home, 'userdata')
if (!existsSync(resolve(from, 'sidedoor.sqlite'))) throw new Error(`No Sidedoor data in ${from}`)
if (to === from) throw new Error('The dev home is the real home; refusing to copy it onto itself.')

// Build the copy next to the old dev data, then swap, so a failure leaves the old dev data alone.
const next = `${to}.next`
rmSync(next, { recursive: true, force: true })
mkdirSync(next, { recursive: true })
const src = new DatabaseSync(resolve(from, 'sidedoor.sqlite'), { readOnly: true })
src.exec(`vacuum into '${resolve(next, 'sidedoor.sqlite').replace(/'/g, "''")}'`)
src.close()
if (existsSync(resolve(from, 'files'))) cpSync(resolve(from, 'files'), resolve(next, 'files'), { recursive: true })

const db = new DatabaseSync(resolve(next, 'sidedoor.sqlite'))
const row = db.prepare("select value from settings where key = 'app'").get()
if (row?.value) {
  const s = JSON.parse(row.value)
  const off = (section, key) => s[section] && (s[section][key] = false)
  off('scout', 'enabled')
  off('triage', 'enabled')
  off('discover', 'enabled')
  off('funding', 'enabled')
  off('prep', 'auto')
  off('research', 'auto')
  off('notify', 'ntfyEnabled')
  off('notify', 'desktop')
  off('notify', 'digest')
  db.prepare("update settings set value = ? where key = 'app'").run(JSON.stringify(s))
}
// Work queued in the real app isn't this copy's to run.
db.exec("update tasks set status = 'cancelled' where status in ('queued', 'running')")
db.close()

// The dev home keeps its own sign-in token and Electron profile; only the data is replaced.
const keep = ['secrets', 'logs']
for (const k of keep) if (existsSync(resolve(to, k))) cpSync(resolve(to, k), resolve(next, k), { recursive: true })
if (existsSync(to)) renameSync(to, `${to}.old`)
renameSync(next, to)
rmSync(`${to}.old`, { recursive: true, force: true })
console.log(`[dev:data] copied ${from} → ${to} (scout, automatic AI jobs and notifications off)`)
