import { describe, expect, it, vi } from 'vitest'
import type { CollaborationAdmissionPolicy } from './collaboration-admission'
import type { CollaborationMessage } from './collaboration-message'
import { CollaborationRuntimeSession } from './collaboration-runtime-session'
import type { CollaborationPlan } from './types'

const PLAN: CollaborationPlan = {
  objective: 'Share findings during one run',
  maxConcurrency: 2,
  steps: [
    { key: 'producer', instruction: 'Investigate.' },
    {
      key: 'consumer',
      instruction: 'Use findings.',
      subscribesTo: ['/findings']
    }
  ]
}

const POLICY: CollaborationAdmissionPolicy = {
  acceptedTypes: ['finding'],
  minPriority: 'normal'
}

function finding(id: string, body: string): CollaborationMessage {
  return {
    id,
    topic: '/findings',
    type: 'finding',
    priority: 'normal',
    producerKey: 'producer',
    body
  }
}

describe('CollaborationRuntimeSession', () => {
  it('publishes through topic routing and commits subscriber context at a checkpoint', async () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    const message = finding('message-1', 'schema v31 is risky')

    const deliveryIds = session.publish(message, ({ subscriberKey }) => `delivery-${subscriberKey}`)

    expect(deliveryIds).toEqual(['delivery-consumer'])
    const commitContext = vi.fn(async () => {})
    await session.checkpoint({
      taskId: 'task-consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      commitContext
    })

    expect(commitContext).toHaveBeenCalledWith([
      {
        deliveryId: 'delivery-consumer',
        message
      }
    ])
    expect(session.getDelivery('delivery-consumer')).toMatchObject({
      state: 'acked',
      deliveryAttempt: 1
    })
  })

  it('routes no delivery to an unsubscribed step and rejects unknown task identities', async () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })

    expect(
      session.publish(finding('message-1', 'x'), ({ subscriberKey }) => subscriberKey)
    ).toEqual(['consumer'])
    await expect(
      session.checkpoint({
        taskId: 'task-missing',
        nowMs: 1_000,
        leaseMs: 100,
        limit: 10,
        commitContext: async () => {}
      })
    ).rejects.toThrow('Unknown collaboration task: task-missing')
  })

  it('keeps failed checkpoint deliveries recoverable through lease expiry', async () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    session.publish(finding('message-1', 'retry'), () => 'delivery-1')
    const commitError = new Error('context commit failed')

    await expect(
      session.checkpoint({
        taskId: 'task-consumer',
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

    expect(session.releaseExpired(1_100).map((delivery) => delivery.id)).toEqual(['delivery-1'])
    expect(session.getDelivery('delivery-1')).toMatchObject({ state: 'pending' })
  })

  it('rejects subscribed steps without an own admission policy', () => {
    const plan: CollaborationPlan = {
      objective: 'Reject inherited policy keys',
      maxConcurrency: 1,
      steps: [
        {
          key: 'constructor',
          instruction: 'Consume safely.',
          subscribesTo: ['/findings']
        }
      ]
    }

    expect(
      () =>
        new CollaborationRuntimeSession({
          plan,
          taskIdsByStepKey: { constructor: 'task-constructor' },
          admissionByStepKey: {}
        })
    ).toThrow('Missing collaboration admission policy for step: constructor')
  })

  it('allows partial task mappings for steps that are not checkpointed yet', () => {
    expect(
      () =>
        new CollaborationRuntimeSession({
          plan: PLAN,
          taskIdsByStepKey: { consumer: 'task-consumer' },
          admissionByStepKey: { consumer: POLICY }
        })
    ).not.toThrow()
  })

  it('rejects task mappings that reference unknown collaboration steps', () => {
    expect(
      () =>
        new CollaborationRuntimeSession({
          plan: PLAN,
          taskIdsByStepKey: {
            producer: 'task-producer',
            consumer: 'task-consumer',
            typo: 'task-typo'
          },
          admissionByStepKey: { consumer: POLICY }
        })
    ).toThrow('Unknown collaboration step key in task mapping: typo')
  })

  it('rejects delivery id collisions before mutating the mailbox', () => {
    const plan: CollaborationPlan = {
      objective: 'Fan out atomically',
      maxConcurrency: 2,
      steps: [
        { key: 'consumer-a', instruction: 'Consume A.', subscribesTo: ['/findings'] },
        { key: 'consumer-b', instruction: 'Consume B.', subscribesTo: ['/findings'] }
      ]
    }
    const session = new CollaborationRuntimeSession({
      plan,
      taskIdsByStepKey: { 'consumer-a': 'task-a', 'consumer-b': 'task-b' },
      admissionByStepKey: { 'consumer-a': POLICY, 'consumer-b': POLICY }
    })

    expect(() =>
      session.publish(finding('message-1', 'fanout'), () => 'delivery-duplicate')
    ).toThrow('Duplicate collaboration delivery id')
    expect(session.getDelivery('delivery-duplicate')).toBeUndefined()
  })
})
