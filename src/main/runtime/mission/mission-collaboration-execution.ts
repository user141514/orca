import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { CollaborationExecutionPort } from '../collaboration/collaboration-execution-port'
import type { CollaborationPlan, CollaborationRunReceipt } from '../collaboration/types'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationControlPlane } from '../orchestration/orchestration-control-plane'
import { OrchestrationExecutorRouter } from '../orchestration/orchestration-executor-router'
import { RuntimeOrchestrationRunner } from '../orchestration/orchestration-runtime-runner'
import { LocalWorkerExecutor } from '../rpc/methods/orchestration-local-worker-executor'

export class MissionCollaborationExecution implements CollaborationExecutionPort {
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly worktreeId: string,
    private readonly agent: TuiAgent,
    private readonly timeoutMs = 60_000
  ) {}

  async start(plan: CollaborationPlan): Promise<CollaborationRunReceipt> {
    const db = this.runtime.getOrchestrationDb()
    const consumerId = `mission:${randomUUID()}`
    const control = new OrchestrationControlPlane(db, consumerId)
    const materialized = control.startPlan({
      objective: plan.objective,
      maxConcurrency: plan.maxConcurrency,
      tasks: plan.steps.map((step) => ({
        key: step.key,
        spec: step.instruction,
        deps: step.dependsOn ?? [],
        execution: {
          backend: 'local-worker',
          config: {
            worktreeId: this.worktreeId,
            agent: this.agent,
            timeoutMs: this.timeoutMs
          }
        }
      }))
    })
    const executor = new OrchestrationExecutorRouter(db, {
      'local-worker': new LocalWorkerExecutor(this.runtime)
    })
    const runner = new RuntimeOrchestrationRunner(this.runtime, consumerId, executor)
    void runner.runExisting(materialized.run.id).catch((error: unknown) => {
      console.error(`[mission] Run ${materialized.run.id} coordinator failed:`, error)
    })
    return { runId: materialized.run.id }
  }
}
