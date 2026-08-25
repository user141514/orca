import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationRuntimeSession } from '../collaboration/collaboration-runtime-session'
import { OrchestrationDb } from '../orchestration/db'
import { OrcaRuntimeService } from '../orca-runtime'
import { registerCollaborationRuntimeSession } from './collaboration-runtime-registry'
import { CollaborationToolCheckpointService } from './collaboration-tool-checkpoint-service'

let db: OrchestrationDb | undefined

afterEach(() => {
  db?.close()
  db = undefined
})

function setup() {
  db = new OrchestrationDb(':memory:')
  const runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  const run = db.createRun({ objective: 'tool checkpoint' })
  const producerTask = db.createTask({ runId: run.id, spec: 'Publish findings.' })
  const consumerTask = db.createTask({ runId: run.id, spec: 'Consume findings.' })
  const paneKey = 'tab_consumer:leaf_consumer'
  const launchToken = 'launch-token-consumer'
  db.createDispatchContext(
    consumerTask.id,
    'term_consumer',
    paneKey,
    createHash('sha256').update(launchToken).digest('hex'),
    'runtime_test:term_consumer:1'
  )
  vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
    runtimeId: 'runtime_test',
    terminalHandle: 'term_consumer',
    ptyId: 'pty_consumer',
    worktreeId: 'repo::worktree',
    paneKey,
    processIncarnation: 'runtime_test:term_consumer:1',
    launchTokenHash: createHash('sha256').update(launchToken).digest('hex'),
    hostScope: { kind: 'local', hostId: 'local' }
  })
  const session = new CollaborationRuntimeSession({
    plan: {
      objective: 'tool checkpoint',
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
  session.publishFromTask({
    taskId: producerTask.id,
    message: {
      id: 'publication-1',
      topic: '/findings',
      type: 'finding',
      priority: 'normal',
      body: 'tool checkpoint finding'
    },
    deliveryIdFor: () => 'delivery-1'
  })
  registerCollaborationRuntimeSession(runtime, run.id, session)
  return { runtime, session, paneKey, launchToken }
}

describe('CollaborationToolCheckpointService', () => {
  it('prepares collaboration context from a launch-token-bound active Dispatch', () => {
    const { runtime, session, paneKey, launchToken } = setup()
    const service = new CollaborationToolCheckpointService(runtime)

    const result = service.prepare({ paneKey, launchToken, nowMs: 1_000 })

    expect(result).toMatchObject({
      active: true,
      entries: [
        {
          deliveryId: 'delivery-1',
          deliveryAttempt: 1,
          message: { body: 'tool checkpoint finding', producerKey: 'producer' }
        }
      ]
    })
    expect(session.getDelivery('delivery-1')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 1
    })
  })

  it('rejects stale worker incarnations even when the Dispatch launch-token commitment still matches', () => {
    const { runtime, session, paneKey, launchToken } = setup()
    vi.mocked(runtime.getOrchestrationDispatchAuthority).mockReturnValue({
      runtimeId: 'runtime_test',
      terminalHandle: 'term_consumer',
      ptyId: 'pty_consumer-new',
      worktreeId: 'repo::worktree',
      paneKey,
      processIncarnation: 'runtime_test:term_consumer:2',
      launchTokenHash: createHash('sha256').update('new-launch-token').digest('hex'),
      hostScope: { kind: 'local', hostId: 'local' }
    })
    const service = new CollaborationToolCheckpointService(runtime)

    expect(service.prepare({ paneKey, launchToken, nowMs: 1_000 })).toEqual({
      active: false,
      entries: []
    })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('fails closed without claiming context when pane or launch token authority is stale', () => {
    const { runtime, session, paneKey, launchToken } = setup()
    const service = new CollaborationToolCheckpointService(runtime)

    expect(service.prepare({ paneKey: 'tab_other:leaf_other', launchToken, nowMs: 1_000 })).toEqual(
      {
        active: false,
        entries: []
      }
    )
    expect(service.prepare({ paneKey, launchToken: 'wrong-token', nowMs: 1_000 })).toEqual({
      active: false,
      entries: []
    })
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('acknowledges only the launch-token-bound task delivery attempt', () => {
    const { runtime, session, paneKey, launchToken } = setup()
    const service = new CollaborationToolCheckpointService(runtime)
    const prepared = service.prepare({ paneKey, launchToken, nowMs: 1_000 })
    const [entry] = prepared.entries

    const result = service.acknowledge({
      paneKey,
      launchToken,
      nowMs: 1_001,
      acknowledgements: [{ deliveryId: entry!.deliveryId, deliveryAttempt: entry!.deliveryAttempt }]
    })

    expect(result).toEqual({
      active: true,
      ackedDeliveryIds: ['delivery-1'],
      ignoredDeliveryIds: []
    })
    expect(session.getDelivery('delivery-1')?.state).toBe('acked')
  })

  it('returns inactive for collaboration tasks that do not subscribe to context', () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'producer only' })
    const task = db.createTask({ runId: run.id, spec: 'Publish findings.' })
    const paneKey = 'tab_producer:leaf_producer'
    const launchToken = 'producer-launch'
    const launchTokenHash = createHash('sha256').update(launchToken).digest('hex')
    db.createDispatchContext(
      task.id,
      'term_producer',
      paneKey,
      launchTokenHash,
      'runtime_test:term_producer:1'
    )
    vi.spyOn(runtime, 'getOrchestrationDispatchAuthority').mockReturnValue({
      runtimeId: 'runtime_test',
      terminalHandle: 'term_producer',
      ptyId: 'pty_producer',
      worktreeId: 'repo::worktree',
      paneKey,
      processIncarnation: 'runtime_test:term_producer:1',
      launchTokenHash,
      hostScope: { kind: 'local', hostId: 'local' }
    })
    registerCollaborationRuntimeSession(
      runtime,
      run.id,
      new CollaborationRuntimeSession({
        plan: {
          objective: 'producer only',
          maxConcurrency: 1,
          steps: [{ key: 'producer', instruction: 'Publish findings.', publishesTo: ['/findings'] }]
        },
        taskIdsByStepKey: { producer: task.id },
        admissionByStepKey: {}
      })
    )
    const service = new CollaborationToolCheckpointService(runtime)

    expect(service.prepare({ paneKey, launchToken, nowMs: 1_000 })).toEqual({
      active: false,
      entries: []
    })
  })

  it('returns inactive when the active Dispatch has no collaboration session', () => {
    db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'ordinary pi' })
    const task = db.createTask({ runId: run.id, spec: 'ordinary work' })
    const paneKey = 'tab_plain:leaf_plain'
    const launchToken = 'plain-launch'
    db.createDispatchContext(
      task.id,
      'term_plain',
      paneKey,
      createHash('sha256').update(launchToken).digest('hex')
    )
    const service = new CollaborationToolCheckpointService(runtime)

    expect(service.prepare({ paneKey, launchToken, nowMs: 1_000 })).toEqual({
      active: false,
      entries: []
    })
  })
})
