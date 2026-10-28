import { db } from './client'

/**
 * Make a service command all-or-nothing: every write inside `fn` commits together or not at all.
 * Nested commands become savepoints, so commands can call each other freely.
 * Synchronous work only (better-sqlite3 transactions can't span an `await`); notify/enqueue
 * network work after the command returns.
 */
export const atomic =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): R =>
    db.$client.transaction(() => fn(...args))()
