import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'
import type { RunCoordinationLease } from './run-consumer'

export type RunControlPolicy = {
  maxConcurrency: number
}

export function setRunControlPolicy(
  this: OrchestrationDb,
  lease: RunCoordinationLease,
  policy: RunControlPolicy
): RunControlPolicy {
  if (!Number.isInteger(policy.maxConcurrency) || policy.maxConcurrency < 1) {
    throw new OrchestrationError(
      'invalid_argument',
      'Run maxConcurrency must be a positive integer.'
    )
  }
  this.db.exec('BEGIN IMMEDIATE')
  try {
    this.requireRunConsumer(lease)
    this.db
      .prepare(
        `INSERT INTO run_control_policies (run_id, max_concurrency)
         VALUES (?, ?)
         ON CONFLICT(run_id) DO UPDATE SET
           max_concurrency = excluded.max_concurrency,
           updated_at = datetime('now')`
      )
      .run(lease.runId, policy.maxConcurrency)
    this.db.exec('COMMIT')
    return policy
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function getRunControlPolicy(
  this: OrchestrationDb,
  runId: string
): RunControlPolicy | undefined {
  const row = this.db
    .prepare('SELECT max_concurrency FROM run_control_policies WHERE run_id = ?')
    .get(runId) as { max_concurrency: number } | undefined
  return row ? { maxConcurrency: row.max_concurrency } : undefined
}

export type RunControlPolicyMethods = {
  setRunControlPolicy: typeof setRunControlPolicy
  getRunControlPolicy: typeof getRunControlPolicy
}

export function attachRunControlPolicy(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { setRunControlPolicy, getRunControlPolicy })
}
