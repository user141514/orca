import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'
import { SCHEMA_VERSION } from './db/contract-constants'

describe('detached mission Run persistence', () => {
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

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('creates a detached mission without binding or unbinding a terminal Run', () => {
    const d = createDb()
    const terminalRun = d.createRun({
      objective: 'terminal ownership remains intact',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:leaf_coord'
    })

    const mission = d.createDetachedMissionRun({
      objective: 'persist independently owned work',
      worktreeId: 'wt_mission',
      plannerSelectionJson: '{"model":"planner"}',
      workerSelectionJson: '{"model":"worker"}',
      maxConcurrency: 3,
      ownerFingerprint: 'owner_fp',
      stopSecretHash: 'stop_hash'
    })

    expect(mission).toMatchObject({
      controller_kind: 'mission',
      coordinator_handle: null,
      coordinator_pane_key: null
    })
    expect(d.getRun(terminalRun.id)).toMatchObject({
      controller_kind: 'terminal',
      coordinator_handle: 'term_coord',
      coordinator_pane_key: 'tab_coord:leaf_coord'
    })
    expect(d.readDetachedMissionRun(mission.id)).toMatchObject({
      run_id: mission.id,
      lifecycle: 'queued',
      worktree_id: 'wt_mission',
      planner_selection_json: '{"model":"planner"}',
      worker_selection_json: '{"model":"worker"}',
      max_concurrency: 3,
      owner_fingerprint: 'owner_fp',
      stop_secret_hash: 'stop_hash',
      supervisor_generation: 0,
      terminal_outcome: null,
      last_error: null
    })
  })

  it('updates mission recovery state and lists only nonterminal missions', () => {
    const d = createDb()
    const rehydratable = d.createDetachedMissionRun({
      objective: 'continue after restart',
      worktreeId: null,
      plannerSelectionJson: '{}',
      workerSelectionJson: '{}',
      maxConcurrency: 1,
      ownerFingerprint: 'owner_active',
      stopSecretHash: 'hash_active'
    })
    const completed = d.createDetachedMissionRun({
      objective: 'finished mission',
      worktreeId: 'wt_finished',
      plannerSelectionJson: '{}',
      workerSelectionJson: '{}',
      maxConcurrency: 1,
      ownerFingerprint: 'owner_finished',
      stopSecretHash: 'hash_finished'
    })

    expect(
      d.updateDetachedMissionRun(rehydratable.id, {
        lifecycle: 'running',
        supervisorGeneration: 2,
        lastError: 'restart interrupted supervision'
      })
    ).toMatchObject({
      lifecycle: 'running',
      supervisor_generation: 2,
      last_error: 'restart interrupted supervision'
    })
    d.updateDetachedMissionRun(completed.id, {
      lifecycle: 'succeeded',
      terminalOutcome: 'succeeded'
    })

    expect(d.listRehydratableDetachedMissionRuns().map((mission) => mission.run_id)).toEqual([
      rehydratable.id
    ])
  })

  it('rejects generic terminal binding for a mission-owned Run', () => {
    const d = createDb()
    const mission = d.createDetachedMissionRun({
      objective: 'mission ownership cannot become pane ownership',
      worktreeId: null,
      plannerSelectionJson: '{}',
      workerSelectionJson: '{}',
      maxConcurrency: 1,
      ownerFingerprint: 'owner_fp',
      stopSecretHash: 'stop_hash'
    })

    expect(
      d.bindRun({
        runId: mission.id,
        coordinatorHandle: 'term_attempt',
        coordinatorPaneKey: 'tab_attempt:leaf_attempt'
      })
    ).toBeUndefined()
    expect(d.getRun(mission.id)).toMatchObject({
      coordinator_handle: null,
      coordinator_pane_key: null
    })
  })

  for (const storedVersion of [30, 31, 32]) {
    it(`migrates a v${storedVersion} profile additively to the detached mission schema`, () => {
      tempDir = mkdtempSync(join(tmpdir(), `orca-mission-v${storedVersion}-`))
      const dbPath = join(tempDir, 'orchestration.db')
      const fresh = new OrchestrationDb(dbPath)
      fresh.close()

      const raw = new Database(dbPath)
      raw.exec('DROP TABLE mission_runs')
      raw.exec('ALTER TABLE runs DROP COLUMN controller_kind')
      raw.exec('CREATE TABLE profile_v32_extension (id TEXT PRIMARY KEY, retained_value TEXT NOT NULL)')
      raw.prepare('INSERT INTO profile_v32_extension VALUES (?, ?)').run('extension', 'must survive')
      raw.pragma(`user_version = ${storedVersion}`)
      raw.close()

      db = new OrchestrationDb(dbPath)
      const sqlite = (db as unknown as { db: Database.Database }).db
      expect(sqlite.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      expect(
        sqlite.prepare('SELECT retained_value FROM profile_v32_extension WHERE id = ?').get('extension')
      ).toEqual({ retained_value: 'must survive' })
      expect(
        sqlite
          .prepare("SELECT dflt_value FROM pragma_table_info('runs') WHERE name = 'controller_kind'")
          .get()
      ).toEqual({ dflt_value: "'terminal'" })
      expect(sqlite.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', 'mission_runs')).toEqual({
        name: 'mission_runs'
      })
    })
  }
})
