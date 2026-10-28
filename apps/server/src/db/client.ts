import { createTableRelationsHelpers, extractTablesRelationalConfig } from 'drizzle-orm/relations'
import { BetterSQLiteSession } from 'drizzle-orm/better-sqlite3/session'
import { readdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { BaseSQLiteDatabase, SQLiteSyncDialect } from 'drizzle-orm/sqlite-core'
import { paths } from '../config'
import * as schema from './schema'
import { SqliteClient } from './sqlite'

type Schema = typeof schema

/** Drizzle's better-sqlite3 driver, minus its top-level `import 'better-sqlite3'`. */
const construct = (client: SqliteClient) => {
  const dialect = new SQLiteSyncDialect()
  const tables = extractTablesRelationalConfig(schema, createTableRelationsHelpers)
  const rel = { fullSchema: schema, schema: tables.tables, tableNamesMap: tables.tableNamesMap }
  // biome-ignore lint: drizzle's session takes the better-sqlite3 client shape, which SqliteClient implements.
  const session = new BetterSQLiteSession(client as never, dialect, rel as never, {})
  const db = new BaseSQLiteDatabase('sync', dialect, session as never, rel as never) as unknown as BaseSQLiteDatabase<'sync', { changes: number; lastInsertRowid: number | bigint }, Schema> & {
    $client: SqliteClient
  }
  db.$client = client
  return db
}

const open = (file = paths.db) => {
  const client = new SqliteClient(file)
  client.pragma('journal_mode = WAL')
  client.pragma('synchronous = NORMAL')
  client.pragma('busy_timeout = 10000')
  client.pragma('foreign_keys = ON')
  const db = construct(client)
  const migrations = readMigrationFiles({ migrationsFolder: paths.migrations })
  backupBeforeMigrating(client, migrations)
  // biome-ignore lint: dialect.migrate is public at runtime but typed internal.
  ;(db as unknown as { dialect: SQLiteSyncDialect; session: unknown }).dialect.migrate(migrations, (db as never as { session: never }).session, {
    migrationsFolder: paths.migrations,
  })
  return db
}

/** Backups taken before a schema change; older ones are deleted. */
const KEEP_MIGRATION_BACKUPS = 5

/**
 * A copy of the database before an update changes its structure, so a bad migration can be undone
 * by putting the copy back (userdata/backups/before-update-*.sqlite).
 */
export const backupBeforeMigrating = (client: SqliteClient, migrations: Array<{ folderMillis: number }>) => {
  const applied = client.prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'").get()
  // A new database has nothing to lose.
  if (!applied) return
  const last = Number((client.prepare('select max(created_at) as at from __drizzle_migrations').get() as { at: number | null }).at ?? 0)
  if (!migrations.some((m) => m.folderMillis > last)) return
  const dest = resolve(paths.backups, `before-update-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
  client.exec(`vacuum into '${dest.replace(/'/g, "''")}'`)
  const old = readdirSync(paths.backups).filter((f) => f.startsWith('before-update-')).sort().slice(0, -KEEP_MIGRATION_BACKUPS)
  for (const f of old) rmSync(resolve(paths.backups, f), { force: true })
}

export type Db = ReturnType<typeof open>

// One connection per process, surviving module reloads in dev.
const g = globalThis as unknown as { __sidedoorDb?: Db }
export const db: Db = (g.__sidedoorDb ??= open())
export { schema }
