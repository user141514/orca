import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../shared/tui-agent'
import { buildCollaborationStepInput } from '../collaboration/collaboration-context'
import { buildCollaborationWorkerProtocol } from '../collaboration/collaboration-worker-protocol'
import type { CollaborationExecutionPort } from '../collaboration/collaboration-execution-port'
import { CollaborationRuntimeSession } from '../collaboration/collaboration-runtime-session'
import type { CollaborationPlan, CollaborationRunReceipt } from '../collaboration/types'
import {
  registerCollaborationRuntimeSession,
  unregisterCollaborationRuntimeSession
} from '../collaboration-runtime/collaboration-runtime-registry'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationControlPlane } from '../orchestration/orchestration-control-plane'
import { OrchestrationExecutorRouter } from '../orchestration/orchestration-executor-router'
import { RuntimeOrchestrationRunner } from '../orchestration/orchestration-runtime-runner'
import {
  LocalWorkerExecutor,
  type LocalWorkerTaskInputResolver
} from '../rpc/methods/orchestration-local-worker-executor'
import type { LocalWorkerTaskProtocolInstructionBuilder } from '../rpc/methods/orchestration-local-worker-provision'

export class MissionCollaborationExecution implements CollaborationExecutionPort {
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly worktreeId: string,
    private readonly agent: TuiAgent,
    private readonly timeoutMs = 60_000
  ) {}

  async start(plan: CollaborationPlan): Promise<CollaborationRunReceipt> {
    const db = this.runtime.getOrchestrationDb()
    const devMode = process.env.ORCA_USER_DATA_PATH?.includes('orca-dev') === true
    const consumerId = `mission:${randomUUID()}`
    const control = new OrchestrationControlPlane(db, consumerId)
    const materialized = control.startPlan({
      objective: plan.objective,
      maxConcurrency: plan.maxConcurrency,
      tasks: plan.steps.map((step) => ({
        key: step.key,
        spec: step.instruction,
        deps: [...new Set([...(step.dependsOn ?? []), ...(step.contextFrom ?? [])])],
        execution: {
          backend: 'local-worker',
          config: {
            worktreeId: this.worktreeId,
            agent: this.agent,
            timeoutMs: this.timeoutMs,
            ...(devMode ? { devMode: true } : {})
          }
        }
      }))
    })
    const taskIdsByStepKey = Object.fromEntries(
      Object.entries(materialized.tasksByKey).map(([stepKey, task]) => [stepKey, task.id])
    )
    const admissionByStepKey = Object.fromEntries(
      plan.steps.flatMap((step) =>
        step.admission
          ? [
              [
                step.key,
                {
                  acceptedTypes: [...step.admission.acceptedTypes],
                  minPriority: step.admission.minPriority
                }
              ] as const
            ]
          : []
      )
    )
    registerCollaborationRuntimeSession(
      this.runtime,
      materialized.run.id,
      new CollaborationRuntimeSession({
        plan,
        taskIdsByStepKey,
        admissionByStepKey
      })
    )
    const resolveTaskInput = buildTaskInputResolver(plan, materialized.tasksByKey)
    const buildTaskProtocolInstructions = buildTaskProtocolInstructionBuilder(
      plan,
      materialized.tasksByKey
    )
    const executor = new OrchestrationExecutorRouter(db, {
      'local-worker': new LocalWorkerExecutor(this.runtime, {
        resolveTaskInput,
        buildTaskProtocolInstructions
      })
    })
    const runner = new RuntimeOrchestrationRunner(this.runtime, consumerId, executor)
    void runner
      .runExisting(materialized.run.id)
      .then((result) => {
        if (result.state === 'completed') {
          unregisterCollaborationRuntimeSession(this.runtime, materialized.run.id)
        }
      })
      .catch((error: unknown) => {
        unregisterCollaborationRuntimeSession(this.runtime, materialized.run.id)
        console.error(`[mission] Run ${materialized.run.id} coordinator failed:`, error)
      })
    return { runId: materialized.run.id }
  }
}

function buildTaskProtocolInstructionBuilder(
  plan: CollaborationPlan,
  tasksByKey: Record<string, { id: string }>
): LocalWorkerTaskProtocolInstructionBuilder {
  const collaborationByTaskId = new Map<
    string,
    { publishesTo: readonly string[]; subscribesTo: readonly string[] }
  >()
  for (const step of plan.steps) {
    const task = tasksByKey[step.key]
    if (!task) {
      throw new Error(`Collaboration step ${step.key} was not materialized.`)
    }
    collaborationByTaskId.set(task.id, {
      publishesTo: step.publishesTo ?? [],
      subscribesTo: step.subscribesTo ?? []
    })
  }

  return (input) => {
    const collaboration = collaborationByTaskId.get(input.taskId)
    if (!collaboration) {
      return ''
    }
    return buildCollaborationWorkerProtocol({ ...input, ...collaboration })
  }
}

function buildTaskInputResolver(
  plan: CollaborationPlan,
  tasksByKey: Record<string, { id: string }>
): LocalWorkerTaskInputResolver {
  const contextSourcesByTaskId = new Map<string, { taskId: string; stepKey: string }[]>()

  for (const step of plan.steps) {
    const task = tasksByKey[step.key]
    if (!task) {
      throw new Error(`Collaboration step ${step.key} was not materialized.`)
    }
    const sources = (step.contextFrom ?? []).map((stepKey) => {
      const source = tasksByKey[stepKey]
      if (!source) {
        throw new Error(`Unknown collaboration context source: ${stepKey}`)
      }
      return { taskId: source.id, stepKey }
    })
    contextSourcesByTaskId.set(task.id, sources)
  }

  return ({ taskId, spec, dependencies }) => {
    const sources = contextSourcesByTaskId.get(taskId) ?? []
    if (sources.length === 0) {
      return spec
    }
    const dependenciesById = new Map(
      dependencies.map((dependency) => [dependency.taskId, dependency])
    )
    const context = sources.map((source) => {
      const dependency = dependenciesById.get(source.taskId)
      if (!dependency) {
        throw new Error(
          `Collaboration context source ${source.stepKey} is not an execution dependency.`
        )
      }
      if (dependency.result === null) {
        throw new Error(
          `Collaboration context source ${source.stepKey} completed without a result.`
        )
      }
      return { stepKey: source.stepKey, result: dependency.result }
    })
    return buildCollaborationStepInput(spec, context)
  }
}
