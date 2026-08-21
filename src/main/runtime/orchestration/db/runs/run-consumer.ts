import { OrchestrationError } from '../../orchestration-error'
import type { OrchestrationDb } from '../orchestration-db'

export type RunCoordinationLease = {
  runId: string
  consumerId: string
  generation: number
}

export function acquireRunConsumer(
  this: OrchestrationDb,
  params: { runId: string; consumerId: string }
): RunCoordinationLease {
  this.db.exec('BEGIN IMMEDIATE')
  try {
    const run = this.getRunRaw(params.runId)
    if (!run || run.legacy === 1) {
      throw new OrchestrationError('run_not_found', `Run ${params.runId} was not found.`)
    }
    if (run.coordination_consumer_id === params.consumerId) {
      this.db.exec('COMMIT')
      return {
        runId: run.id,
        consumerId: params.consumerId,
        generation: run.consumer_generation
      }
    }
    if (run.coordinator_handle) {
      this.routeAllUnreadDirectMessagesToRunMailbox(run.id, run.coordinator_handle)
    }
    this.db
      .prepare(
        `UPDATE runs
         SET coordination_consumer_id = ?, coordinator_handle = NULL, coordinator_pane_key = NULL,
             consumer_generation = consumer_generation + 1, updated_at = datetime('now')
         WHERE id = ?`
      )
      .run(params.consumerId, run.id)
    this.fenceOutstandingDelivery(run.id)
    const rebound = this.getRunRaw(run.id)
    this.db.exec('COMMIT')
    return {
      runId: run.id,
      consumerId: params.consumerId,
      generation: rebound?.consumer_generation ?? run.consumer_generation + 1
    }
  } catch (error) {
    this.db.exec('ROLLBACK')
    throw error
  }
}

export function requireRunConsumer(this: OrchestrationDb, lease: RunCoordinationLease): void {
  const run = this.getRunRaw(lease.runId)
  if (
    !run ||
    run.legacy === 1 ||
    run.coordination_consumer_id !== lease.consumerId ||
    run.consumer_generation !== lease.generation
  ) {
    throw new OrchestrationError('consumer_fenced', 'This coordination consumer has been replaced.')
  }
}

export type RunConsumerMethods = {
  acquireRunConsumer: typeof acquireRunConsumer
  requireRunConsumer: typeof requireRunConsumer
}

export function attachRunConsumer(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, {
    acquireRunConsumer,
    requireRunConsumer
  })
}
