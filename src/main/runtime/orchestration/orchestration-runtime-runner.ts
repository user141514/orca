import type { OrcaRuntimeService } from '../orca-runtime'
import {
  OrchestrationControlPlane,
  OrchestrationScheduler,
  type OrchestrationExecutor,
  type OrchestrationPlan
} from './orchestration-control-plane'
import type { MessageRow } from './types'

export type RuntimeOrchestrationRunnerResult = {
  runId: string
  state: 'completed' | 'blocked'
  attention?: MessageRow[]
}

export class RuntimeOrchestrationRunner {
  private readonly waitTimeoutMs: number
  private readonly signal: AbortSignal | undefined

  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly consumerId: string,
    private readonly executor: OrchestrationExecutor,
    options: { waitTimeoutMs?: number; signal?: AbortSignal } = {}
  ) {
    this.waitTimeoutMs = options.waitTimeoutMs ?? 60_000
    this.signal = options.signal
  }

  async runPlan(plan: OrchestrationPlan): Promise<RuntimeOrchestrationRunnerResult> {
    const db = this.runtime.getOrchestrationDb()
    const control = new OrchestrationControlPlane(db, this.consumerId)
    const materialized = control.startPlan(plan)
    return this.runExisting(materialized.run.id)
  }

  async runExisting(runId: string): Promise<RuntimeOrchestrationRunnerResult> {
    const db = this.runtime.getOrchestrationDb()
    const control = new OrchestrationControlPlane(db, this.consumerId)
    control.useRun(runId)
    const scheduler = new OrchestrationScheduler(db, this.consumerId)
    scheduler.useRun(runId)

    for (;;) {
      if (this.signal?.aborted) {
        throw new Error(`Run ${runId} coordination was cancelled.`)
      }
      const tick = scheduler.tick()
      if (tick.started.length > 0) {
        await Promise.all(
          tick.started.map((entry) =>
            Promise.resolve(
              this.executor.execute({
                runId,
                taskId: entry.taskId,
                dispatchId: entry.dispatchId,
                execution: entry.execution
              })
            )
          )
        )
        continue
      }
      if (tick.state === 'completed' || tick.state === 'blocked') {
        return { runId, state: tick.state }
      }

      const lease = control.getLease()
      const delivery = db.getOrCreateRunDelivery({
        runId,
        consumerGeneration: lease.generation
      })
      if (delivery) {
        const attention = delivery.messages.filter((message) =>
          ['question', 'escalation', 'decision_gate'].includes(message.type)
        )
        if (attention.length > 0) {
          return { runId, state: 'blocked', attention }
        }
        db.acknowledgeRunDelivery({
          runId,
          consumerGeneration: lease.generation,
          deliveryId: delivery.delivery.id
        })
        continue
      }

      const wait = await this.runtime.waitForMessage(`run:${runId}`, {
        timeoutMs: this.waitTimeoutMs,
        signal: this.signal,
        exclusive: true
      })
      if (wait === 'waiter_exists') {
        throw new Error(`Run ${runId} already has an active coordination waiter.`)
      }
      if (wait === 'cancelled') {
        throw new Error(`Run ${runId} coordination wait was cancelled.`)
      }
    }
  }
}
