import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrchestrationDb } from './db'

describe('detached mission runtime boot', () => {
  it('rehydrates persisted detached missions when orchestration storage is installed', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    const rehydrateScan = vi.spyOn(db, 'listRehydratableDetachedMissionRuns')

    runtime.setOrchestrationDb(db)

    await vi.waitFor(() => expect(rehydrateScan).toHaveBeenCalledTimes(1))
    db.close()
  })

  it('contains synchronous detached-service construction failures during rehydration', () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.spyOn(runtime, 'getDetachedMissionRunService').mockImplementation(() => {
      throw new Error('service construction failed')
    })

    expect(() => runtime.setOrchestrationDb(db)).not.toThrow()
    expect(warn).toHaveBeenCalledWith(
      '[orchestration] detached mission rehydration failed',
      expect.objectContaining({ message: 'service construction failed' })
    )
    db.close()
  })

  it('wakes detached mission supervision when lifecycle mail arrives for its Run mailbox', async () => {
    const runtime = new OrcaRuntimeService()
    const db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    await vi.waitFor(() => expect(db.listRehydratableDetachedMissionRuns()).toEqual([]))

    const service = runtime.getDetachedMissionRunService()
    const run = service.create({
      objective: 'event-driven supervision',
      worktreeId: 'wt_a',
      plannerSelection: { agent: 'codex' },
      workerSelection: { agent: 'codex' },
      tasks: [{ key: 'a', spec: 'first', deps: [] }],
      maxConcurrency: 1,
      ownerFingerprint: 'owner',
      stopSecretHash: 'hash'
    })
    const supervise = vi.spyOn(service, 'supervise').mockResolvedValue()

    runtime.notifyMessageArrived(`run:${run.id}`, 'worker_done')

    await vi.waitFor(() => expect(supervise).toHaveBeenCalledWith(run.id))
    db.close()
  })
})
