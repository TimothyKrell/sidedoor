import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { db } from '../src/db/client'
import { paths } from '../src/config'
import { subscribe } from '../src/events'
import { startLiveChanges } from '../src/live'
import { logInteraction, upsertPerson } from '../src/services/people'
import { getSettings, saveSettings, setMeta } from '../src/settings'

const counters = () => Object.fromEntries((db.$client.prepare('select tbl, seq from change_counters').all() as { tbl: string; seq: number }[]).map((r) => [r.tbl, r.seq]))

test('every write to a watched table bumps its counter', () => {
  const before = counters()
  const p = upsertPerson({ name: 'Live Person', companyName: 'Ramp' })
  logInteraction({ personId: p.id, channel: 'email', direction: 'out', summary: 'hi' })
  const after = counters()
  expect(after.people).toBeGreaterThan(before.people!)
  expect(after.interactions).toBeGreaterThan(before.interactions!)
  expect(after.companies).toBeGreaterThan(before.companies!)
  expect(after.postings).toBe(before.postings)
})

test('worker bookkeeping (meta:*) is not a change; settings edits are', () => {
  const before = counters().settings
  setMeta('lastScan', { at: new Date().toISOString() })
  expect(counters().settings).toBe(before)
  saveSettings(getSettings())
  expect(counters().settings).toBeGreaterThan(before!)
})

test('pages hear about writes made through another connection', async () => {
  const heard: string[][] = []
  startLiveChanges()
  const stop = subscribe((e) => e.type === 'changes' && heard.push(e.tables))
  // Stand-in for any other writer: a separate connection writing straight to the file.
  const other = new DatabaseSync(paths.db)
  other.prepare("insert into activity (id, kind, title, at) values ('act_live_test', 'system', 'from the worker', ?)").run(new Date().toISOString())
  other.close()
  await new Promise((r) => setTimeout(r, 1200))
  stop()
  expect(heard.flat()).toContain('activity')
})
