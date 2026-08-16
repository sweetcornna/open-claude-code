import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { config } from '../config'
import { migrations } from './migrations'

let database: Database | undefined
let databasePathOverride: string | undefined

function prepareParent(path: string) {
  if (path === ':memory:' || path.startsWith('file:')) return
  mkdirSync(dirname(path), { recursive: true })
}

function migrateDatabase(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `)

  for (const migration of migrations) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const applied = db
        .query('SELECT 1 AS applied FROM schema_migrations WHERE version = ?')
        .get(migration.version) as { applied: number } | null
      if (!applied) {
        migration.up(db)
        db.query(
          'INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)',
        ).run(migration.version, Date.now())
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

function openDatabase(path: string): Database {
  prepareParent(path)
  const db = new Database(path, { create: true, strict: true })
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA journal_mode = WAL')
  migrateDatabase(db)
  return db
}

export function getDatabase(): Database {
  if (!database) {
    database = openDatabase(databasePathOverride ?? config.databasePath)
  }
  return database
}

export function closeDatabase() {
  database?.close(false)
  database = undefined
}

export function setDatabasePathForTests(path: string) {
  closeDatabase()
  databasePathOverride = path
}

export function clearDatabasePathOverride() {
  closeDatabase()
  databasePathOverride = undefined
}
