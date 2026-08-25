import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('Run consumer generation migration', () => {
  let db: OrchestrationDb | undefined
  let tempDir: string | undefined

  afterEach(() => {
    db?.close()
    db = undefined
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = undefined
    }
  })

  it('adds consumer_generation when upgrading a v29 runs table', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'orca-run-consumer-generation-migration-'))
    const dbPath = join(tempDir, 'orchestration.db')
    db = new OrchestrationDb(dbPath)
    const run = db.createRun({ objective: 'upgrade me' })
    db.close()
    db = undefined

    const oldDb = new Database(dbPath)
    oldDb.exec(`
      ALTER TABLE runs DROP COLUMN coordination_consumer_id;
      ALTER TABLE runs DROP COLUMN consumer_generation;
    `)
    oldDb.pragma('user_version = 29')
    oldDb.close()

    db = new OrchestrationDb(dbPath)
    const sqlite = (db as unknown as { db: Database.Database }).db

    expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
    const columns = sqlite.prepare('PRAGMA table_info(runs)').all() as { name: string }[]
    expect(columns.map((column) => column.name)).toContain('coordination_consumer_id')
    expect(columns.map((column) => column.name)).toContain('consumer_generation')
    expect(
      sqlite
        .prepare('SELECT coordination_consumer_id, consumer_generation FROM runs WHERE id = ?')
        .get(run.id)
    ).toEqual({ coordination_consumer_id: null, consumer_generation: 0 })
  })
})
