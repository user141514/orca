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
        { key: 'review', instruction: 'Review draft.', dependsOn: ['draft'] }
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
})
