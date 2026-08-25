import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import { OrcaRuntimeService } from '../../orca-runtime'
import { createWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import { provisionAcceptedLocalWorker } from './orchestration-local-worker-provision'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
  vi.restoreAllMocks()
})

describe('provisionAcceptedLocalWorker', () => {
  it('appends opaque task protocol instructions before the assignment', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'protocol extension' })
    const task = db.createTask({ spec: 'perform accepted work', runId: run.id })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:term_worker:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    const send = vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })

    await provisionAcceptedLocalWorker({
      runtime,
      db,
      runId: run.id,
      task: { id: task.id, spec: task.spec },
      dispatchId: started.dispatch.id,
      coordinatorAddress: `run:${run.id}`,
      placement: { kind: 'existing-workspace', worktreeId: 'repo::worktree' },
      agent: 'codex',
      launch: { preferences: undefined, receipt: createWorkerLaunchReceipt({ agent: 'codex' }) },
      timeoutMs: 60_000,
      buildTaskProtocolInstructions: ({ taskId, cli }) => `=== TEST PROTOCOL ===\n${cli}:${taskId}`
    })

    const prompt = String(send.mock.calls[0]?.[1])
    expect(prompt).toContain('=== TEST PROTOCOL ===')
    expect(prompt.indexOf('=== TEST PROTOCOL ===')).toBeLessThan(
      prompt.indexOf('perform accepted work')
    )
  })

  it('provisions an already accepted Dispatch without a coordinator terminal binding', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'provision accepted dispatch' })
    const task = db.createTask({ spec: 'perform accepted work', runId: run.id })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })

    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worktree',
      title: 'worker'
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_worker',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue('tab_worker:leaf_worker')
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue('runtime_test:term_worker:1')
    vi.spyOn(runtime, 'getTerminalOrchestrationCliCommand').mockReturnValue('orca')
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_worker',
      accepted: true,
      bytesWritten: 1
    })

    const result = await provisionAcceptedLocalWorker({
      runtime,
      db,
      runId: run.id,
      task: { id: task.id, spec: task.spec },
      dispatchId: started.dispatch.id,
      coordinatorAddress: `run:${run.id}`,
      placement: { kind: 'existing-workspace', worktreeId: 'repo::worktree' },
      agent: 'codex',
      launch: {
        preferences: undefined,
        receipt: createWorkerLaunchReceipt({ agent: 'codex' })
      },
      timeoutMs: 60_000
    })

    expect(result).toMatchObject({
      runId: run.id,
      taskId: task.id,
      dispatchId: started.dispatch.id,
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(db.getWorkerDispatch(started.dispatch.id)?.state).toBe('ready')
    expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
      startupAgent: 'codex',
      title: `worker-${task.id}`,
      surfaceOwner: false
    })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_worker',
      expect.stringContaining(`run:${run.id}`)
    )
    expect(String(vi.mocked(runtime.sendTerminalAgentPrompt).mock.calls[0]?.[1])).not.toContain(
      '=== COLLABORATION PROTOCOL ==='
    )
  })
})
