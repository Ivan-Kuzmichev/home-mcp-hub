import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type Db = BetterSQLite3Database<typeof schema>

type DbHandle = { sqlite: Database.Database; db: Db }

const globalForDb = globalThis as unknown as { __hubDb?: DbHandle }

function open(): DbHandle {
  const file = process.env.DATABASE_PATH ?? '/data/hub.db'
  let sqlite: Database.Database
  try {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    sqlite = new Database(file)
  } catch (error) {
    const uid = typeof process.getuid === 'function' ? process.getuid() : '?'
    throw new Error(`Cannot open database ${file} as uid ${uid}: ${error instanceof Error ? error.message : String(error)} — check that the data directory is writable`)
  }
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('busy_timeout = 5000')
  return { sqlite, db: drizzle(sqlite, { schema }) }
}

/** Process-wide connection, shared between route handlers, middleware and instrumentation. */
export function getDb(): Db {
  globalForDb.__hubDb ??= open()
  return globalForDb.__hubDb.db
}

export { schema }
