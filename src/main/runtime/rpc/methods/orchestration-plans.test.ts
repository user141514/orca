import { afterEach, describe, expect, it } from 'vitest'
import type { RpcContext } from '../core'
import type { OrchestrationDb } from '../../orchestration/db'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

describe('orchestration plan RPC methods', () => {
  const h = createOrchestrationRpcHarness()
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService
  let ctx: RpcContext

  afterEach(() => h.cleanup())

  it('creates a durable unbound Run and materializes its structured plan', async () => {
    ;({ db, runtime, ctx } = h.setup(false))
    const result = (await h.call(
      'orchestration.planCreate',
      {
        objective: 'first-class plan entry',
        maxConcurrency: 2,
        tasks: [
          {
            key: 'a',
            spec: 'branch A',
            execution: {
              backend: 'local-worker',
              config: { worktreeId: 'repo::worker', agent: 'codex' }
            }
          },
          { key: 'b', spec: 'branch B', deps: ['a'] }
        ]
      },
      ctx
    )) as {
      run: { id: string; coordinator_handle: string | null }
      tasksByKey: Record<string, { id: string }>
      maxConcurrency: number
    }

    expect(result.run.coordinator_handle).toBeNull()
    expect(result.maxConcurrency).toBe(2)
    expect(db.getRunControlPolicy(result.run.id)).toMatchObject({ maxConcurrency: 2 })
    expect(db.getTask(result.tasksByKey.a!.id)?.execution_spec).toContain('local-worker')
    expect(db.getTask(result.tasksByKey.b!.id)?.status).toBe('pending')
    expect(runtime.getTerminalPaneKey).not.toHaveBeenCalled()
  })

  it('runs an existing empty plan to completion without a coordinator terminal', async () => {
    ;({ ctx } = h.setup(false))
    const created = (await h.call(
      'orchestration.planCreate',
      { objective: 'empty durable run', maxConcurrency: 1, tasks: [] },
      ctx
    )) as { run: { id: string } }

    const result = await h.call('orchestration.planRun', { run: created.run.id }, ctx)

    expect(result).toMatchObject({ runId: created.run.id, state: 'completed' })
  })
})
