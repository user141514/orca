import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { startFederatedWorker } from './orchestration-federated-worker-start'
import { WorkerStartParams } from './orchestration-worker-start-schema'
import { provisionAcceptedLocalWorker } from './orchestration-local-worker-provision'
import { prepareLocalWorkerDispatchAcceptance } from './orchestration-local-worker-preflight'

export const ORCHESTRATION_WORKER_START_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'orchestration.workerStart',
    params: WorkerStartParams,
    handler: async (params, { runtime, orchestrationMutation }) => {
      const db = runtime.getOrchestrationDb()
      const coordinatorPane = runtime.getTerminalPaneKey(params.from)
      const run = coordinatorPane ? db.getCurrentRunForPane(coordinatorPane) : undefined
      if (!run || (params.run && params.run !== run.id)) {
        throw new OrchestrationError(
          'consumer_fenced',
          'worker-start requires the coordinator terminal currently bound to the Task Run.'
        )
      }
      const task = db.getTask(params.task)
      if (!task || task.run_id !== run.id) {
        throw new OrchestrationError(
          'task_not_found',
          `Task ${params.task} was not found in Run ${run.id}.`
        )
      }

      if (params.on) {
        return startFederatedWorker({
          params,
          runtime,
          db,
          runId: run.id,
          task,
          orchestrationMutation
        })
      }

      const prepared = await prepareLocalWorkerDispatchAcceptance({ runtime, params })
      const started = db.createStartingWorkerDispatch({
        taskId: task.id,
        retryOf: params.retryOf,
        startOptions: prepared.startOptions,
        runtimeEpoch: runtime.getRuntimeId(),
        mutationReceipt: orchestrationMutation
      })
      return provisionAcceptedLocalWorker({
        runtime,
        db,
        runId: run.id,
        task: { id: task.id, spec: task.spec },
        dispatchId: started.dispatch.id,
        coordinatorAddress: params.from,
        placement: prepared.placement,
        agent: prepared.agent,
        launch: prepared.launch,
        timeoutMs: params.timeoutMs ?? 60_000,
        devMode: params.devMode
      })
    }
  })
]
