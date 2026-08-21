import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import type { OrchestrationExecutor } from './orchestration-control-plane'
import { OrchestrationExecutorRouter } from './orchestration-executor-router'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

describe('OrchestrationExecutorRouter', () => {
  it('routes a Dispatch by its persisted execution backend', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({ objective: 'route executor' })
    const task = db.createTask({ spec: 'route me', runId: run.id })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    const localExecute = vi.fn()
    const local: OrchestrationExecutor = { execute: localExecute }
    const router = new OrchestrationExecutorRouter(db, { 'local-worker': local })
    const input = {
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      execution: { backend: 'local-worker', config: { worktreeId: 'repo::worker' } }
    }

    await router.execute(input)

    expect(localExecute).toHaveBeenCalledWith(input)
  })

  it('fails an accepted Dispatch truthfully when no executor backend is registered', async () => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({ objective: 'unsupported executor' })
    const task = db.createTask({ spec: 'unsupported', runId: run.id })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    const router = new OrchestrationExecutorRouter(db, {})

    await router.execute({
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      execution: { backend: 'future-backend' }
    })

    expect(db.getWorkerDispatch(started.dispatch.id)).toMatchObject({
      state: 'failed',
      stage: 'executor_route'
    })
    expect(db.getTask(task.id)?.status).toBe('failed')
  })
})
