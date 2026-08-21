import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../../orchestration/db'
import {
  OrchestrationControlPlane,
  OrchestrationScheduler
} from '../../orchestration/orchestration-control-plane'
import { OrcaRuntimeService } from '../../orca-runtime'
import { LocalWorkerExecutor } from './orchestration-local-worker-executor'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
  vi.restoreAllMocks()
})

describe('LocalWorkerExecutor', () => {
  it('provisions a Scheduler-created Dispatch from the persisted execution descriptor', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'validateOrchestrationAgentLauncher').mockImplementation(() => {})
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worker',
      repoId: 'repo'
    } as never)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_worker',
      worktreeId: 'repo::worker',
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

    const control = new OrchestrationControlPlane(db, 'controller-main')
    const materialized = control.startPlan({
      objective: 'run a real local worker adapter',
      maxConcurrency: 1,
      tasks: [
        {
          key: 'worker',
          spec: 'perform local work',
          execution: {
            backend: 'local-worker',
            config: { worktreeId: 'repo::worker', agent: 'codex' }
          }
        }
      ]
    })
    const scheduler = new OrchestrationScheduler(db, 'controller-main')
    scheduler.useRun(materialized.run.id)
    const started = scheduler.tick().started[0]!

    const executor = new LocalWorkerExecutor(runtime)
    await executor.execute({
      runId: materialized.run.id,
      taskId: started.taskId,
      dispatchId: started.dispatchId,
      execution: started.execution
    })

    expect(db.getWorkerDispatch(started.dispatchId)).toMatchObject({
      state: 'ready',
      stage: 'input_accepted'
    })
    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('id:repo::worker')
    expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worker', {
      startupAgent: 'codex',
      title: `worker-${started.taskId}`,
      surfaceOwner: false
    })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_worker',
      expect.stringContaining(`run:${materialized.run.id}`)
    )
  })
})
