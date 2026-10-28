import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { paths } from '../src/config'
import { backupBeforeMigrating, db } from '../src/db/client'

const backups = () => readdirSync(paths.backups).filter((f) => f.startsWith('before-update-'))
const last = () => Number((db.$client.prepare('select max(created_at) as at from __drizzle_migrations').get() as { at: number }).at)

test('the database is copied before an update changes its structure, and only then', () => {
  db.$client.exec("insert into settings (key, value) values ('backup-test', 'kept')")
  // Every migration already applied: nothing to back up.
  backupBeforeMigrating(db.$client, [{ folderMillis: last() }])
  expect(backups()).toHaveLength(0)

  backupBeforeMigrating(db.$client, [{ folderMillis: last() }, { folderMillis: last() + 1 }])
  expect(backups()).toHaveLength(1)
  const copy = resolve(paths.backups, backups()[0]!)
  expect(existsSync(copy)).toBe(true)
  const d = new DatabaseSync(copy, { readOnly: true })
  expect(d.prepare("select value from settings where key = 'backup-test'").get()).toEqual({ value: 'kept' })
  d.close()
})

test('only the last five pre-update backups are kept', async () => {
  for (let i = 0; i < 7; i++) {
    backupBeforeMigrating(db.$client, [{ folderMillis: last() + 1 }])
    await new Promise((r) => setTimeout(r, 5))
  }
  expect(backups()).toHaveLength(5)
})
