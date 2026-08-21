import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CollaborationPlan } from '../collaboration/types'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from '../orchestration/db'
import { RuntimeOrchestrationRunner } from '../orchestration/orchestration-runtime-runner'
import { MissionCollaborationExecution } from './mission-collaboration-execution'

let db: OrchestrationDb | undefined

afterEach(() => {
  vi.restoreAllMocks()
  db?.close()
  db = undefined
})

describe('MissionCollaborationExecution', () => {
  it('maps a semantic collaboration plan onto the existing orchestration runtime', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const runExisting = vi
      .spyOn(RuntimeOrchestrationRunner.prototype, 'runExisting')
      .mockImplementation(async (runId) => ({ runId, state: 'completed' }))
    const execution = new MissionCollaborationExecution(runtime, 'repo::worktree', 'codex')
    const plan: CollaborationPlan = {
      objective: 'Draft then review',
      maxConcurrency: 2,
      steps: [
        { key: 'draft', instruction: 'Write draft.' },
        { key: 'review', instruction: 'Review draft.', contextFrom: ['draft'] }
      ]
    }

    const receipt = await execution.start(plan)

    expect(runExisting).toHaveBeenCalledWith(receipt.runId)
    const tasks = db.listTasks({ runId: receipt.runId })
    const bySpec = new Map(tasks.map((task) => [task.spec, task]))
    expect(JSON.parse(bySpec.get('Write draft.')!.deps)).toEqual([])
    expect(JSON.parse(bySpec.get('Review draft.')!.deps)).toEqual([bySpec.get('Write draft.')!.id])
    for (const task of tasks) {
      expect(JSON.parse(task.execution_spec ?? '')).toEqual({
        backend: 'local-worker',
        config: {
          worktreeId: 'repo::worktree',
          agent: 'codex',
          timeoutMs: 60_000
        }
      })
    }
  })

  it('passes selected predecessor results into the dependent worker prompt', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo'
    } as never)
    let terminalIndex = 0
    vi.spyOn(runtime, 'createTerminal').mockImplementation(async () => {
      terminalIndex += 1
      return {
        handle: `term_worker_${terminalIndex}`,
        worktreeId: 'repo::worktree',
        title: `worker-${terminalIndex}`
      }
    })
    vi.spyOn(runtime, 'waitForTerminal').mockImplementation(async (handle) => ({
      handle,
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    }))
    vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) => `tab:${handle}`)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation(
      (handle) => `runtime_test:${handle}:1`
    )
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const prompts: string[] = []
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockImplementation(async (handle, prompt) => {
      prompts.push(prompt)
      const taskId = /Your task ID is: (task_[^\s]+)/u.exec(prompt)?.[1]
      const dispatchId = /--dispatch-id (ctx_[^\s]+)/u.exec(prompt)?.[1]
      if (!taskId || !dispatchId) {
        throw new Error('worker prompt omitted orchestration lifecycle IDs')
      }
      setTimeout(() => {
        const task = db!.getTask(taskId)!
        const result = task.spec === 'produce source result' ? 'source conclusion' : 'done'
        db!.settleWorkerReport({ taskId, dispatchId, outcome: 'succeeded', result })
        const message = db!.insertMessage({
          runId: task.run_id,
          from: `dispatch:${dispatchId}`,
          to: `run:${task.run_id}`,
          subject: 'done',
          body: result,
          type: 'worker_done',
          payload: JSON.stringify({ taskId, dispatchId, outcome: 'succeeded' })
        })
        runtime.notifyMessageArrived(message.to_handle, message.type)
      }, 0)
      return { handle, accepted: true, bytesWritten: prompt.length }
    })

    const execution = new MissionCollaborationExecution(runtime, 'repo::worktree', 'codex')
    const receipt = await execution.start({
      objective: 'source then consumer',
      maxConcurrency: 1,
      steps: [
        { key: 'source', instruction: 'produce source result' },
        {
          key: 'consumer',
          instruction: 'consume source result',
          dependsOn: ['source'],
          contextFrom: ['source']
        }
      ]
    } as CollaborationPlan)

    await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 1_000 })
    expect(prompts[0]).not.toContain('=== PREDECESSOR RESULTS ===')
    expect(prompts[1]).toContain('=== PREDECESSOR RESULTS ===')
    expect(prompts[1]).toContain('[source]\nsource conclusion')
    expect(prompts[1]).toContain('=== CURRENT STEP ===\nconsume source result')
    await vi.waitFor(
      () =>
        expect(
          db!.listTasks({ runId: receipt.runId }).every((task) => task.status === 'completed')
        ).toBe(true),
      { timeout: 1_000 }
    )
  })
})
