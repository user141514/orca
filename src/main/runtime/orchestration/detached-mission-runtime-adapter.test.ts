import { describe, expect, it, vi } from 'vitest'
import type { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'
import { createRootDispatch } from './db/root-dispatch-test-fixture'
import { createDetachedMissionRuntimeService } from './detached-mission-runtime-adapter'
import { ORCHESTRATION_WORKER_STOP_METHODS } from '../rpc/methods/orchestration-worker-stop'
import { ORCHESTRATION_WORKER_START_METHODS } from '../rpc/methods/orchestration-workers'

describe('createDetachedMissionRuntimeService', () => {
  it('rehydrates a queued mission through the runtime-owned worker lifecycle once', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = {} as OrcaRuntimeService
    const start = vi.fn(async ({ taskId }: { taskId: string }) => ({
      state: 'ready',
      dispatchId: createRootDispatch(db, taskId, `term_${taskId}`).id
    }))
    const service = createDetachedMissionRuntimeService(runtime, db, {
      start,
      stop: async () => undefined
    })
    const run = service.create({
      objective: 'resume',
      worktreeId: 'wt_mission',
      plannerSelection: {},
      workerSelection: { agent: 'codex' },
      tasks: [{ key: 'first', spec: 'resume first task', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'stop'
    })
    await Promise.all([service.rehydrate(), service.rehydrate()])

    expect(start).toHaveBeenCalledTimes(1)
    expect(db.listTasks({ runId: run.id })).toHaveLength(1)
    db.close()
  })

  it('uses the existing worker start and stop handlers under an internal mission context', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = {} as OrcaRuntimeService
    const startHandler = ORCHESTRATION_WORKER_START_METHODS.find(
      (method) => method.name === 'orchestration.workerStart'
    )!
    const stopHandler = ORCHESTRATION_WORKER_STOP_METHODS.find(
      (method) => method.name === 'orchestration.workerStop'
    )!
    const start = vi.spyOn(startHandler, 'handler').mockImplementation(async (params) => {
      const input = params as { task: string }
      return { state: 'ready', dispatchId: createRootDispatch(db, input.task, 'term_worker').id }
    })
    const stop = vi.spyOn(stopHandler, 'handler').mockResolvedValue({ state: 'stopped' })
    const service = createDetachedMissionRuntimeService(runtime, db)
    const run = service.create({
      objective: 'lifecycle adapter',
      worktreeId: 'wt_mission',
      plannerSelection: {},
      workerSelection: { agent: 'codex', model: 'gpt-test', effort: 'high' },
      tasks: [{ key: 'first', spec: 'start and stop', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'stop'
    })

    await service.supervise(run.id)
    await service.stop(run.id)

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        run: run.id,
        from: `run:${run.id}`,
        worktree: 'id:wt_mission',
        model: 'gpt-test',
        effort: 'high'
      }),
      expect.objectContaining({ runtime, internalDetachedMissionRunId: run.id })
    )
    expect(stop).toHaveBeenCalledWith({ dispatch: expect.any(String) }, { runtime })
    db.close()
  })
})
