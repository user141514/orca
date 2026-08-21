import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import type { OrchestrationExecutor } from './orchestration-control-plane'
import { RuntimeOrchestrationRunner } from './orchestration-runtime-runner'
import { OrcaRuntimeService } from '../orca-runtime'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

describe('RuntimeOrchestrationRunner', () => {
  it('waits for asynchronous worker_done lifecycle events before scheduling dependent work', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const started: string[] = []
    const completed: string[] = []
    const executor: OrchestrationExecutor = {
      execute: ({ runId, taskId, dispatchId }) => {
        started.push(taskId)
        db!.markWorkerDispatchReady(dispatchId)
        const delayMs = started.length === 1 ? 5 : started.length === 2 ? 10 : 5
        setTimeout(() => {
          db!.settleWorkerReport({
            taskId,
            dispatchId,
            outcome: 'succeeded',
            result: `completed ${taskId}`
          })
          completed.push(taskId)
          const message = db!.insertMessage({
            runId,
            from: `dispatch:${dispatchId}`,
            to: `run:${runId}`,
            subject: 'done',
            body: `completed ${taskId}`,
            type: 'worker_done',
            payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
          })
          runtime.notifyMessageArrived(message.to_handle, message.type)
        }, delayMs)
      }
    }
    const runner = new RuntimeOrchestrationRunner(runtime, 'controller-main', executor, {
      waitTimeoutMs: 100
    })

    const result = await runner.runPlan({
      objective: 'async DAG',
      maxConcurrency: 2,
      tasks: [
        { key: 'a', spec: 'branch A' },
        { key: 'b', spec: 'branch B' },
        { key: 'c', spec: 'join', deps: ['a', 'b'] }
      ]
    })

    expect(result.state).toBe('completed')
    const tasks = db.listTasks({ runId: result.runId })
    const bySpec = new Map(tasks.map((task) => [task.spec, task]))
    expect(started.slice(0, 2).sort()).toEqual(
      [bySpec.get('branch A')!.id, bySpec.get('branch B')!.id].sort()
    )
    expect(started[2]).toBe(bySpec.get('join')!.id)
    expect(completed).toHaveLength(3)
    expect(tasks.every((task) => task.status === 'completed')).toBe(true)
  })
})
