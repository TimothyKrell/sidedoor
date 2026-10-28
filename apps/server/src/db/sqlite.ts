import { DatabaseSync, type StatementSync } from 'node:sqlite'

/**
 * The slice of the better-sqlite3 API that Drizzle's sync driver uses, on top of Node's built-in
 * `node:sqlite`. Using the built-in module means there's no native addon to rebuild for each
 * Electron ABI (T3 Code makes the same call). Drizzle calls prepare → run/all/get, `.raw()` for
 * array rows, and `transaction(fn)[behavior](...)`.
 */
type Param = null | number | bigint | string | Uint8Array
const norm = (params: unknown[]): Param[] =>
  params.map((p) => {
    if (p === undefined) return null
    if (typeof p === 'boolean') return p ? 1 : 0
    if (Buffer.isBuffer(p)) return new Uint8Array(p)
    return p as Param
  })

class Statement {
  constructor(
    private readonly stmt: StatementSync,
    private readonly arrays = false,
  ) {
    stmt.setReturnArrays(arrays)
  }
  raw() {
    return new Statement(this.stmt, true)
  }
  run(...params: unknown[]) {
    this.stmt.setReturnArrays(false)
    const r = this.stmt.run(...norm(params))
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid }
  }
  all(...params: unknown[]) {
    this.stmt.setReturnArrays(this.arrays)
    return this.stmt.all(...norm(params)) as unknown[]
  }
  get(...params: unknown[]) {
    this.stmt.setReturnArrays(this.arrays)
    return this.stmt.get(...norm(params)) as unknown
  }
}

export class SqliteClient {
  readonly db: DatabaseSync
  private depth = 0
  constructor(path: string) {
    this.db = new DatabaseSync(path)
  }
  prepare(sql: string) {
    return new Statement(this.db.prepare(sql))
  }
  exec(sql: string) {
    this.db.exec(sql)
    return this
  }
  pragma(p: string) {
    this.db.exec(`PRAGMA ${p}`)
  }
  close() {
    this.db.close()
  }
  get inTransaction() {
    return this.depth > 0
  }
  transaction<A extends unknown[], R>(fn: (...args: A) => R) {
    const run =
      (begin: string) =>
      (...args: A): R => {
        // Like better-sqlite3: a transaction inside a transaction becomes a savepoint.
        const sp = this.depth > 0 ? `sd_sp_${this.depth}` : null
        this.db.exec(sp ? `SAVEPOINT ${sp}` : begin)
        this.depth++
        try {
          const r = fn(...args)
          this.db.exec(sp ? `RELEASE ${sp}` : 'COMMIT')
          return r
        } catch (e) {
          if (sp) this.db.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`)
          else if (this.db.isTransaction) this.db.exec('ROLLBACK')
          throw e
        } finally {
          this.depth--
        }
      }
    const deferred = run('BEGIN')
    return Object.assign(deferred, { deferred, immediate: run('BEGIN IMMEDIATE'), exclusive: run('BEGIN EXCLUSIVE') })
  }
}
