import type { OrcaRuntimeService } from '../orca-runtime'
import {
  getCollaborationRuntimeTopology,
  registerCollaborationRuntimeTopology
} from '../collaboration/collaboration-runtime-registry'
import type { OrchestrationDb } from './db'
import {
  DetachedMissionRunService,
  type DetachedMissionWorkerResult,
  type DetachedMissionWorkerStart
} from './detached-mission-run-service'
import { OrchestrationError } from './orchestration-error'
import { ORCHESTRATION_WORKER_STOP_METHODS } from '../rpc/methods/orchestration-worker-stop'
import { ORCHESTRATION_WORKER_START_METHODS } from '../rpc/methods/orchestration-workers'

type DetachedMissionWorkerLifecycle = {
  start(input: DetachedMissionWorkerStart): Promise<DetachedMissionWorkerResult>
  stop(dispatchId: string): Promise<void>
}

export function createDetachedMissionRuntimeService(
  runtime: OrcaRuntimeService,
  db: OrchestrationDb,
  lifecycle: DetachedMissionWorkerLifecycle = createWorkerLifecycle(runtime)
): DetachedMissionRunService {
  return new DetachedMissionRunService({
    db,
    startWorker: lifecycle.start,
    stopWorker: lifecycle.stop,
    configureCollaboration: ({ runId, topology }) => {
      if (!getCollaborationRuntimeTopology(runtime, runId)) {
        registerCollaborationRuntimeTopology(runtime, runId, topology)
      }
    }
  })
}

function createWorkerLifecycle(runtime: OrcaRuntimeService): DetachedMissionWorkerLifecycle {
  return {
    async start(input) {
      if (!input.worktreeId) {
        throw new OrchestrationError(
          'mission_worktree_required',
          `Detached mission task ${input.taskId} has no execution workspace.`
        )
      }
      const result = (await workerStartHandler().handler(
        {
          task: input.taskId,
          run: input.runId,
          from: `run:${input.runId}`,
          worktree: `id:${input.worktreeId}`,
          agent: input.agent,
          ...(input.model ? { model: input.model } : {}),
          ...(input.effort ? { effort: input.effort } : {}),
          ...(input.retryOf ? { retryOf: input.retryOf } : {})
        },
        { runtime, internalDetachedMissionRunId: input.runId }
      )) as DetachedMissionWorkerResult
      return result
    },
    async stop(dispatchId) {
      await workerStopHandler().handler({ dispatch: dispatchId }, { runtime })
    }
  }
}

function workerStartHandler() {
  const handler = ORCHESTRATION_WORKER_START_METHODS.find(
    (method) => method.name === 'orchestration.workerStart'
  )
  if (!handler) {
    throw new Error('orchestration.workerStart handler is unavailable')
  }
  return handler
}

function workerStopHandler() {
  const handler = ORCHESTRATION_WORKER_STOP_METHODS.find(
    (method) => method.name === 'orchestration.workerStop'
  )
  if (!handler) {
    throw new Error('orchestration.workerStop handler is unavailable')
  }
  return handler
}
