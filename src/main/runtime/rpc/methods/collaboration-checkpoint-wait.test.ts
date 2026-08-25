import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import { CollaborationRuntimeSession } from '../../collaboration/collaboration-runtime-session'
import { registerCollaborationRuntimeSession } from '../../collaboration-runtime/collaboration-runtime-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { COLLABORATION_METHODS } from './collaboration'

let db: OrchestrationDb | undefined

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  db?.close()
  db = undefined
})

function collaborationMethod(name: 'collaboration.publish' | 'collaboration.checkpoint') {
  const method = COLLABORATION_METHODS.find((candidate) => candidate.name === name)
  if (!method) {
    throw new Error(`${name} not registered`)
  }
  return method
}

function setupAuthorizedPublish() {
  db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({ objective: 'publish run' })
  const producerTask = db.createTask({ runId: run.id, spec: 'Publish findings.' })
  const consumerTask = db.createTask({ runId: run.id, spec: 'Consume findings.' })
  const producerPaneKey = 'tab_producer:leaf_producer'
  const producerProcessIncarnation = 'runtime_test:term_producer:1'
  const producerDispatch = db.createDispatchContext(
    producerTask.id,
    'term_producer',
    producerPaneKey,
    undefined,
    producerProcessIncarnation
  )
  const producerCapability = db.mintDispatchCapability({
    dispatchId: producerDispatch.id,
    paneKey: producerPaneKey,
    processIncarnation: producerProcessIncarnation
  })
  const consumerPaneKey = 'tab_consumer:leaf_consumer'
  const consumerProcessIncarnation = 'runtime_test:term_consumer:1'
  const consumerDispatch = db.createDispatchContext(
    consumerTask.id,
    'term_consumer',
    consumerPaneKey,
    undefined,
    consumerProcessIncarnation
  )
  const consumerCapability = db.mintDispatchCapability({
    dispatchId: consumerDispatch.id,
    paneKey: consumerPaneKey,
    processIncarnation: consumerProcessIncarnation
  })
  vi.spyOn(runtime, 'getTerminalPaneKey').mockImplementation((handle) =>
    handle === 'term_consumer' ? consumerPaneKey : producerPaneKey
  )
  vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
    handle === 'term_consumer' ? consumerProcessIncarnation : producerProcessIncarnation
  )

  const session = new CollaborationRuntimeSession({
    plan: {
      objective: 'publish run',
      maxConcurrency: 2,
      steps: [
        { key: 'producer', instruction: 'Publish findings.', publishesTo: ['/findings'] },
        {
          key: 'consumer',
          instruction: 'Consume findings.',
          subscribesTo: ['/findings']
        }
      ]
    },
    taskIdsByStepKey: { producer: producerTask.id, consumer: consumerTask.id },
    admissionByStepKey: {
      consumer: { acceptedTypes: ['finding'], minPriority: 'normal' }
    }
  })
  registerCollaborationRuntimeSession(runtime, run.id, session)
  return {
    runtime,
    producerTask,
    consumerTask,
    producerDispatch,
    producerCapability,
    consumerDispatch,
    consumerCapability
  }
}

describe('collaboration.checkpoint wait', () => {
  it('blocks until a future collaboration publication reaches the subscriber', async () => {
    const {
      runtime,
      producerTask,
      consumerTask,
      producerDispatch,
      producerCapability,
      consumerDispatch,
      consumerCapability
    } = setupAuthorizedPublish()
    const checkpoint = collaborationMethod('collaboration.checkpoint')
    const waiting = checkpoint.handler(
      checkpoint.params?.parse({
        from: 'term_consumer',
        taskId: consumerTask.id,
        dispatchId: consumerDispatch.id,
        wait: true,
        timeoutMs: 1_000
      }),
      { runtime, orchestrationCapability: consumerCapability } as RpcContext
    )

    const publish = collaborationMethod('collaboration.publish')
    await publish.handler(
      publish.params?.parse({
        from: 'term_producer',
        taskId: producerTask.id,
        dispatchId: producerDispatch.id,
        publicationId: 'publication-after-wait',
        topic: '/findings',
        type: 'finding',
        priority: 'normal',
        body: 'arrived after wait began'
      }),
      { runtime, orchestrationCapability: producerCapability } as RpcContext
    )

    await expect(waiting).resolves.toMatchObject({
      entries: [
        {
          deliveryAttempt: 1,
          message: { body: 'arrived after wait began' }
        }
      ],
      timedOut: false,
      cancelled: false,
      connectionLost: false
    })
  })

  it('continues an event wait when the first notified message is filtered by admission', async () => {
    const {
      runtime,
      producerTask,
      consumerTask,
      producerDispatch,
      producerCapability,
      consumerDispatch,
      consumerCapability
    } = setupAuthorizedPublish()
    const checkpoint = collaborationMethod('collaboration.checkpoint')
    const waiting = checkpoint.handler(
      checkpoint.params?.parse({
        from: 'term_consumer',
        taskId: consumerTask.id,
        dispatchId: consumerDispatch.id,
        wait: true,
        timeoutMs: 1_000
      }),
      { runtime, orchestrationCapability: consumerCapability } as RpcContext
    )
    const publish = collaborationMethod('collaboration.publish')
    const publishContext = {
      runtime,
      orchestrationCapability: producerCapability
    } as RpcContext

    await publish.handler(
      publish.params?.parse({
        from: 'term_producer',
        taskId: producerTask.id,
        dispatchId: producerDispatch.id,
        publicationId: 'publication-filtered',
        topic: '/findings',
        type: 'status',
        priority: 'normal',
        body: 'filtered status'
      }),
      publishContext
    )
    await publish.handler(
      publish.params?.parse({
        from: 'term_producer',
        taskId: producerTask.id,
        dispatchId: producerDispatch.id,
        publicationId: 'publication-finding',
        topic: '/findings',
        type: 'finding',
        priority: 'normal',
        body: 'accepted finding'
      }),
      publishContext
    )

    await expect(waiting).resolves.toMatchObject({
      entries: [{ message: { body: 'accepted finding' } }],
      timedOut: false
    })
  })

  it('revalidates Dispatch authority after a blocking wait is notified', async () => {
    const {
      runtime,
      producerTask,
      consumerTask,
      producerDispatch,
      producerCapability,
      consumerDispatch,
      consumerCapability
    } = setupAuthorizedPublish()
    const checkpoint = collaborationMethod('collaboration.checkpoint')
    const waiting = checkpoint.handler(
      checkpoint.params?.parse({
        from: 'term_consumer',
        taskId: consumerTask.id,
        dispatchId: consumerDispatch.id,
        wait: true,
        timeoutMs: 1_000
      }),
      { runtime, orchestrationCapability: consumerCapability } as RpcContext
    )

    db!.failDispatch(consumerDispatch.id, 'consumer stopped while waiting')
    const publish = collaborationMethod('collaboration.publish')
    await publish.handler(
      publish.params?.parse({
        from: 'term_producer',
        taskId: producerTask.id,
        dispatchId: producerDispatch.id,
        publicationId: 'publication-after-stop',
        topic: '/findings',
        type: 'finding',
        priority: 'normal',
        body: 'must not reach stopped consumer'
      }),
      { runtime, orchestrationCapability: producerCapability } as RpcContext
    )

    await expect(waiting).rejects.toMatchObject({ code: 'dispatch_inactive' })
  })

  it('cancels a blocking checkpoint on caller abort and releases the waiter slot', async () => {
    const { runtime, consumerTask, consumerDispatch, consumerCapability } = setupAuthorizedPublish()
    const checkpoint = collaborationMethod('collaboration.checkpoint')
    const controller = new AbortController()
    const params = checkpoint.params?.parse({
      from: 'term_consumer',
      taskId: consumerTask.id,
      dispatchId: consumerDispatch.id,
      wait: true,
      timeoutMs: 1_000
    })
    const first = checkpoint.handler(params, {
      runtime,
      orchestrationCapability: consumerCapability,
      signal: controller.signal
    } as RpcContext)

    await expect(
      checkpoint.handler(params, {
        runtime,
        orchestrationCapability: consumerCapability
      } as RpcContext)
    ).rejects.toMatchObject({ code: 'waiter_exists' })

    controller.abort()
    await expect(first).resolves.toEqual({
      entries: [],
      timedOut: false,
      cancelled: true,
      connectionLost: true
    })
  })

  it('reports a blocking checkpoint timeout without polling', async () => {
    vi.useFakeTimers()
    const { runtime, consumerTask, consumerDispatch, consumerCapability } = setupAuthorizedPublish()
    const checkpoint = collaborationMethod('collaboration.checkpoint')
    const waiting = checkpoint.handler(
      checkpoint.params?.parse({
        from: 'term_consumer',
        taskId: consumerTask.id,
        dispatchId: consumerDispatch.id,
        wait: true,
        timeoutMs: 100
      }),
      { runtime, orchestrationCapability: consumerCapability } as RpcContext
    )

    await vi.advanceTimersByTimeAsync(100)
    await expect(waiting).resolves.toEqual({
      entries: [],
      timedOut: true,
      cancelled: false,
      connectionLost: false
    })
  })
})
