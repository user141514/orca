import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { CollaborationRuntimeSession } from '../../collaboration/collaboration-runtime-session'
import {
  registerCollaborationRuntimeSession,
  unregisterCollaborationRuntimeSession
} from '../../collaboration-runtime/collaboration-runtime-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { ALL_RPC_METHODS } from './index'
import { COLLABORATION_METHODS } from './collaboration'

let db: OrchestrationDb | undefined

afterEach(() => {
  vi.restoreAllMocks()
  db?.close()
  db = undefined
})

function checkpointMethod() {
  const method = COLLABORATION_METHODS.find(
    (candidate) => candidate.name === 'collaboration.checkpoint'
  )
  if (!method) {
    throw new Error('collaboration.checkpoint not registered')
  }
  return method
}

function setupAuthorizedCheckpoint() {
  db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({ objective: 'checkpoint run' })
  const task = db.createTask({ runId: run.id, spec: 'Consume findings.' })
  const paneKey = 'tab_worker:leaf_worker'
  const processIncarnation = 'runtime_test:term_worker:1'
  const dispatch = db.createDispatchContext(
    task.id,
    'term_worker',
    paneKey,
    undefined,
    processIncarnation
  )
  const capability = db.mintDispatchCapability({
    dispatchId: dispatch.id,
    paneKey,
    processIncarnation
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_worker' ? paneKey : null
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === 'term_worker' ? processIncarnation : null
  )

  const session = new CollaborationRuntimeSession({
    plan: {
      objective: 'checkpoint run',
      maxConcurrency: 1,
      steps: [
        {
          key: 'consumer',
          instruction: 'Consume findings.',
          subscribesTo: ['/findings']
        }
      ]
    },
    taskIdsByStepKey: { consumer: task.id },
    admissionByStepKey: {
      consumer: { acceptedTypes: ['finding'], minPriority: 'normal' }
    }
  })
  session.publish(
    {
      id: 'message-1',
      topic: '/findings',
      type: 'finding',
      priority: 'high',
      producerKey: 'producer',
      body: 'Use this finding.'
    },
    () => 'delivery-1'
  )
  registerCollaborationRuntimeSession(runtime, run.id, session)

  return { runtime, run, task, dispatch, capability, paneKey, processIncarnation, session }
}

describe('collaboration.checkpoint', () => {
  it('is registered in the runtime RPC manifest', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'collaboration.checkpoint')).toBe(true)
  })

  it('returns admitted context for the authenticated active Dispatch and acknowledges it', async () => {
    const { runtime, task, dispatch, capability, paneKey, session } = setupAuthorizedCheckpoint()
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: task.id,
      dispatchId: dispatch.id,
      senderPaneKey: paneKey
    })

    const result = await method.handler(params, {
      runtime,
      orchestrationCapability: capability
    } as RpcContext)

    expect(result).toEqual({
      entries: [
        {
          deliveryId: 'delivery-1',
          message: expect.objectContaining({ id: 'message-1', body: 'Use this finding.' })
        }
      ]
    })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'acked' })
  })

  it('rejects an invalid Dispatch capability without consuming the mailbox', async () => {
    const { runtime, task, dispatch, paneKey, session } = setupAuthorizedCheckpoint()
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: task.id,
      dispatchId: dispatch.id,
      senderPaneKey: paneKey
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: 'dcap_invalid'
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('rejects a caller that does not own the Dispatch even with its capability', async () => {
    const { runtime, task, dispatch, capability, session } = setupAuthorizedCheckpoint()
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_attacker',
      taskId: task.id,
      dispatchId: dispatch.id
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: capability
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'sender_not_assignee' })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('accepts a capability-backed starting Dispatch while it is still pending', async () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'pending checkpoint' })
    const task = db.createTask({ runId: run.id, spec: 'Consume pending findings.' })
    const started = db.createStartingWorkerDispatch({ taskId: task.id, startOptions: {} })
    const paneKey = 'tab_pending:leaf_pending'
    const processIncarnation = 'runtime_test:term_pending:1'
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId: started.dispatch.id,
      handle: 'term_pending',
      paneKey,
      processIncarnation,
      worktreeId: 'repo::pending',
      effects: [],
      setupState: 'not_applicable'
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(paneKey)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)
    const session = new CollaborationRuntimeSession({
      plan: {
        objective: 'pending checkpoint',
        maxConcurrency: 1,
        steps: [
          {
            key: 'consumer',
            instruction: 'Consume pending findings.',
            subscribesTo: ['/findings']
          }
        ]
      },
      taskIdsByStepKey: { consumer: task.id },
      admissionByStepKey: {
        consumer: { acceptedTypes: ['finding'], minPriority: 'normal' }
      }
    })
    registerCollaborationRuntimeSession(runtime, run.id, session)
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_pending',
      taskId: task.id,
      dispatchId: started.dispatch.id
    })

    await expect(
      method.handler(params, { runtime, orchestrationCapability: capability } as RpcContext)
    ).resolves.toEqual({ entries: [] })
  })

  it('accepts a reminted terminal handle when the stable pane and process still own the Dispatch', async () => {
    const { runtime, task, dispatch, capability, paneKey, processIncarnation, session } =
      setupAuthorizedCheckpoint()
    vi.mocked(runtime.getTerminalPaneKey).mockImplementation((handle) =>
      handle === 'term_worker_reminted' ? paneKey : null
    )
    vi.mocked(runtime.getTerminalProcessIncarnation).mockImplementation((handle) =>
      handle === 'term_worker_reminted' ? processIncarnation : null
    )
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker_reminted',
      taskId: task.id,
      dispatchId: dispatch.id
    })

    const result = await method.handler(params, {
      runtime,
      orchestrationCapability: capability
    } as RpcContext)

    expect(result).toMatchObject({ entries: [{ deliveryId: 'delivery-1' }] })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'acked' })
  })

  it('ignores caller-reported pane identity and verifies the runtime pane', async () => {
    const { runtime, task, dispatch, capability, paneKey, session } = setupAuthorizedCheckpoint()
    vi.mocked(runtime.getTerminalPaneKey).mockReturnValue('tab_other:leaf_other')
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: task.id,
      dispatchId: dispatch.id,
      senderPaneKey: paneKey
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: capability
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'dispatch_capability_invalid' })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('returns a named error when the run has no live collaboration session', async () => {
    const { runtime, run, task, dispatch, capability } = setupAuthorizedCheckpoint()
    unregisterCollaborationRuntimeSession(runtime, run.id)
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: task.id,
      dispatchId: dispatch.id
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: capability
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'collaboration_session_unavailable' })
  })

  it('releases expired deliveries before the checkpoint claim', async () => {
    const { runtime, task, dispatch, capability, session } = setupAuthorizedCheckpoint()
    const commitError = new Error('first commit failed')
    await expect(
      session.checkpoint({
        taskId: task.id,
        nowMs: 1_000,
        leaseMs: 100,
        limit: 10,
        commitContext: async () => {
          throw commitError
        }
      })
    ).rejects.toBe(commitError)
    expect(session.getDelivery('delivery-1')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 1
    })
    vi.spyOn(Date, 'now').mockReturnValue(1_100)
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: task.id,
      dispatchId: dispatch.id
    })

    const result = await method.handler(params, {
      runtime,
      orchestrationCapability: capability
    } as RpcContext)

    expect(result).toMatchObject({ entries: [{ deliveryId: 'delivery-1' }] })
    expect(session.getDelivery('delivery-1')).toMatchObject({
      state: 'acked',
      deliveryAttempt: 2
    })
  })

  it('rejects a task/Dispatch mismatch before reading collaboration state', async () => {
    const { runtime, dispatch, capability, paneKey, session } = setupAuthorizedCheckpoint()
    const method = checkpointMethod()
    const params = method.params?.parse({
      from: 'term_worker',
      taskId: 'task_other',
      dispatchId: dispatch.id,
      senderPaneKey: paneKey
    })

    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: capability
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'task_dispatch_mismatch' })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })
})
