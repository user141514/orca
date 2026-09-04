import type { DetachedMissionRunRow, RunRow } from '../../types'
import type Database from '../../../../sqlite/sync-database'
import { generateId } from '../generated-id'
import type { OrchestrationDb } from '../orchestration-db'

export function createDetachedMissionRun(
  this: OrchestrationDb,
  params: {
    objective: string
    worktreeId: string | null
    plannerSelectionJson: string
    workerSelectionJson: string
    maxConcurrency: number
    ownerFingerprint: string
    stopSecretHash: string
  }
): RunRow {
  const id = generateId('run')
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.db
      .prepare(
        `INSERT INTO runs (id, objective, consumer_generation, legacy, controller_kind)
         VALUES (?, ?, 0, 0, 'mission')`
      )
      .run(id, params.objective)
    this.db
      .prepare(
        `INSERT INTO mission_runs (
           run_id, worktree_id, planner_selection_json, worker_selection_json,
           max_concurrency, owner_fingerprint, stop_secret_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.worktreeId,
        params.plannerSelectionJson,
        params.workerSelectionJson,
        params.maxConcurrency,
        params.ownerFingerprint,
        params.stopSecretHash
      )
    this.db.exec('COMMIT')
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
  return this.getRun(id) as RunRow
}

export function readDetachedMissionRun(
  this: OrchestrationDb,
  runId: string
): DetachedMissionRunRow | undefined {
  return this.db.prepare('SELECT * FROM mission_runs WHERE run_id = ?').get(runId) as
    | DetachedMissionRunRow
    | undefined
}

export function updateDetachedMissionRun(
  this: OrchestrationDb,
  runId: string,
  params: {
    lifecycle?: DetachedMissionRunRow['lifecycle']
    worktreeId?: string | null
    plannerSelectionJson?: string
    workerSelectionJson?: string
    maxConcurrency?: number
    ownerFingerprint?: string
    stopSecretHash?: string
    supervisorGeneration?: number
    terminalOutcome?: DetachedMissionRunRow['terminal_outcome']
    lastError?: string | null
  }
): DetachedMissionRunRow | undefined {
  const updates: [string, Database.BindValue][] = []
  if (params.lifecycle !== undefined) {
    updates.push(['lifecycle', params.lifecycle])
  }
  if (params.worktreeId !== undefined) {
    updates.push(['worktree_id', params.worktreeId])
  }
  if (params.plannerSelectionJson !== undefined) {
    updates.push(['planner_selection_json', params.plannerSelectionJson])
  }
  if (params.workerSelectionJson !== undefined) {
    updates.push(['worker_selection_json', params.workerSelectionJson])
  }
  if (params.maxConcurrency !== undefined) {
    updates.push(['max_concurrency', params.maxConcurrency])
  }
  if (params.ownerFingerprint !== undefined) {
    updates.push(['owner_fingerprint', params.ownerFingerprint])
  }
  if (params.stopSecretHash !== undefined) {
    updates.push(['stop_secret_hash', params.stopSecretHash])
  }
  if (params.supervisorGeneration !== undefined) {
    updates.push(['supervisor_generation', params.supervisorGeneration])
  }
  if (params.terminalOutcome !== undefined) {
    updates.push(['terminal_outcome', params.terminalOutcome])
  }
  if (params.lastError !== undefined) {
    updates.push(['last_error', params.lastError])
  }
  if (updates.length === 0) {
    return this.readDetachedMissionRun(runId)
  }
  const columns = updates.map(([column]) => `${column} = ?`).join(', ')
  this.db
    .prepare(
      `UPDATE mission_runs
       SET ${columns}, updated_at = datetime('now')
       WHERE run_id = ?`
    )
    .run(...updates.map(([, value]) => value), runId)
  return this.readDetachedMissionRun(runId)
}

export function listRehydratableDetachedMissionRuns(this: OrchestrationDb): DetachedMissionRunRow[] {
  return this.db
    .prepare(
      `SELECT * FROM mission_runs
       WHERE terminal_outcome IS NULL
       ORDER BY created_at, run_id`
    )
    .all() as DetachedMissionRunRow[]
}

export type DetachedMissionRunStoreMethods = {
  createDetachedMissionRun: typeof createDetachedMissionRun
  readDetachedMissionRun: typeof readDetachedMissionRun
  updateDetachedMissionRun: typeof updateDetachedMissionRun
  listRehydratableDetachedMissionRuns: typeof listRehydratableDetachedMissionRuns
}

export function attachDetachedMissionRunStore(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    createDetachedMissionRun,
    readDetachedMissionRun,
    updateDetachedMissionRun,
    listRehydratableDetachedMissionRuns
  })
}
