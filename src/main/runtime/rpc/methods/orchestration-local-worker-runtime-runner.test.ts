import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { RuntimeOrchestrationRunner } from '../../orchestration/orchestration-runtime-runner'
import { OrcaRuntimeService } from '../../orca-runtime'
import { LocalWorkerExecutor } from './orchestration-local-worker-executor'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
  vi.restoreAllMocks()
})

describe('local worker orchestration vertical slice', () => {
  it('runs A/B in parallel and starts C only after both worker_done reports settle', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    let terminalSequence = 0
    const completions: string[] = []

    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worker',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async () => {
      terminalSequence += 1
      return {
        handle: `term_worker_${terminalSequence}`,
        worktreeId: 'repo::worker',
        title: `worker-${terminalSequence}`
      }
    })
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => `tab_${handle}:leaf_${handle}`
    )
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (_handle, preamble) => {
      const taskId = /Your task ID is: (task_[^\n]+)/.exec(preamble)?.[1]
      const dispatchId = /--dispatch-id (ctx_[^\s]+)/.exec(preamble)?.[1]
      if (!taskId || !dispatchId) {
        throw new Error('Dispatch preamble did not expose task and dispatch ids.')
      }
      const dispatch = db!.getDispatchContextById(dispatchId)
      if (!dispatch) {
        throw new Error(`Dispatch ${dispatchId} was not found.`)
      }
      setTimeout(
        () => {
          db!.settleWorkerReport({
            taskId,
            dispatchId,
            outcome: 'succeeded',
            result: `completed ${taskId}`
          })
          completions.push(taskId)
          const message = db!.insertMessage({
            runId: dispatch.run_id,
            from: `dispatch:${dispatchId}`,
            to: `run:${dispatch.run_id}`,
            subject: 'done',
            body: `completed ${taskId}`,
            type: 'worker_done',
            payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
          })
          runtime.notifyMessageArrived(message.to_handle, message.type)
        },
        taskId.endsWith('0') ? 10 : 5
      )
      return { handle: _handle, accepted: true, bytesWritten: preamble.length }
    })

    const runner = new RuntimeOrchestrationRunner(
      runtime,
      'controller-main',
      new LocalWorkerExecutor(runtime),
      { waitTimeoutMs: 100 }
    )
    const execution = {
      backend: 'local-worker',
      config: { worktreeId: 'repo::worker', agent: 'codex' }
    }
    const result = await runner.runPlan({
      objective: 'local worker DAG',
      maxConcurrency: 2,
      tasks: [
        { key: 'a', spec: 'branch A', execution },
        { key: 'b', spec: 'branch B', execution },
        { key: 'c', spec: 'join C', deps: ['a', 'b'], execution }
      ]
    })

    expect(result.state).toBe('completed')
    const tasks = db.listTasks({ runId: result.runId })
    const a = tasks.find((task) => task.spec === 'branch A')!
    const b = tasks.find((task) => task.spec === 'branch B')!
    const c = tasks.find((task) => task.spec === 'join C')!
    expect(completions.indexOf(c.id)).toBeGreaterThan(completions.indexOf(a.id))
    expect(completions.indexOf(c.id)).toBeGreaterThan(completions.indexOf(b.id))
    expect(runtime.createTerminal).toHaveBeenCalledTimes(3)
    expect(tasks.every((task) => task.status === 'completed')).toBe(true)
  })
})
