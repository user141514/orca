import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  noteCollaborationPublication,
  registerCollaborationPublicationObligations,
  unregisterCollaborationPublicationObligations
} from '../../collaboration-runtime/collaboration-publication-obligations'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { createOrchestrationRpcHarness } from './orchestration-rpc-test-harness'

const harness = createOrchestrationRpcHarness()
let runtime: OrcaRuntimeService | undefined
let runId: string | undefined

afterEach(() => {
  if (runtime && runId) {
    unregisterCollaborationPublicationObligations(runtime, runId)
  }
  harness.cleanup()
  vi.restoreAllMocks()
  runtime = undefined
  runId = undefined
})

describe('orchestration worker completion with collaboration obligations', () => {
  it('allows failed worker_done even when required publishes are incomplete', async () => {
    const state = harness.setup()
    runtime = state.runtime
    runId = state.activeRunId
    expect(runId).toBeDefined()

    const task = state.db.createTask({ spec: 'Publish required finding.' })
    const paneKey = 'tab_worker:leaf_worker'
    const dispatch = state.db.createDispatchContext(task.id, 'term_worker', paneKey)
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? paneKey : harness.coordinatorPaneKey
    )
    registerCollaborationPublicationObligations(
      state.runtime,
      runId!,
      {
        objective: 'Failure may settle without publication',
        maxConcurrency: 1,
        steps: [
          {
            key: 'producer',
            instruction: 'Publish a finding.',
            publishesTo: ['/findings'],
            requiredPublishesTo: ['/findings']
          }
        ]
      },
      { producer: task.id }
    )

    const result = (await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Cannot publish',
        type: 'worker_done',
        payload: JSON.stringify({
          taskId: task.id,
          dispatchId: dispatch.id,
          outcome: 'failed'
        })
      },
      state.ctx
    )) as { lifecycle: { action: string } }

    expect(result.lifecycle.action).toBe('failed')
    expect(state.db.getTask(task.id)?.status).toBe('failed')
    expect(state.db.getDispatchContextById(dispatch.id)?.status).toBe('failed')
  })

  it('rejects succeeded worker_done until required publishes complete, then allows completion', async () => {
    const state = harness.setup()
    runtime = state.runtime
    runId = state.activeRunId
    expect(runId).toBeDefined()

    const task = state.db.createTask({ spec: 'Publish required finding.' })
    const paneKey = 'tab_worker:leaf_worker'
    const dispatch = state.db.createDispatchContext(task.id, 'term_worker', paneKey)
    vi.mocked(state.runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker' ? paneKey : harness.coordinatorPaneKey
    )

    registerCollaborationPublicationObligations(
      state.runtime,
      runId!,
      {
        objective: 'Publish before completion',
        maxConcurrency: 1,
        steps: [
          {
            key: 'producer',
            instruction: 'Publish a finding.',
            publishesTo: ['/findings'],
            requiredPublishesTo: ['/findings']
          }
        ]
      },
      { producer: task.id }
    )

    const payload = JSON.stringify({
      taskId: task.id,
      dispatchId: dispatch.id,
      outcome: 'succeeded'
    })
    const first = (await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done too early',
        type: 'worker_done',
        payload
      },
      state.ctx
    )) as { lifecycle: { action: string; code?: string; reason?: string } }

    expect(first.lifecycle).toMatchObject({
      action: 'rejected',
      code: 'collaboration_publish_incomplete'
    })
    expect(first.lifecycle.reason).toContain('/findings')
    expect(state.db.getTask(task.id)?.status).toBe('dispatched')
    expect(state.db.getDispatchContextById(dispatch.id)?.status).toBe('dispatched')

    noteCollaborationPublication(state.runtime, runId!, task.id, '/findings')

    const second = (await harness.call(
      'orchestration.send',
      {
        from: 'term_worker',
        to: 'term_coord',
        subject: 'Done after publish',
        type: 'worker_done',
        payload
      },
      state.ctx
    )) as { lifecycle: { action: string } }

    expect(second.lifecycle.action).toBe('completed')
    expect(state.db.getTask(task.id)?.status).toBe('completed')
    expect(state.db.getDispatchContextById(dispatch.id)?.status).toBe('completed')
  })
})
