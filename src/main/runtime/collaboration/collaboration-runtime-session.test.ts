import { describe, expect, it } from 'vitest'
import type { CollaborationAdmissionPolicy } from './collaboration-admission'
import type { CollaborationMessage } from './collaboration-message'
import { CollaborationRuntimeSession } from './collaboration-runtime-session'
import type { CollaborationPlan } from './types'

const PLAN: CollaborationPlan = {
  objective: 'Share findings during one run',
  maxConcurrency: 2,
  steps: [
    { key: 'producer', instruction: 'Investigate.', publishesTo: ['/findings'] },
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
  it('rejects a producer topic that is not declared by its collaboration step', () => {
    const session = new CollaborationRuntimeSession({
      plan: {
        ...PLAN,
        steps: PLAN.steps.map((step) =>
          step.key === 'producer' ? { key: step.key, instruction: step.instruction } : step
        )
      },
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })

    expect(() =>
      session.publishFromTask({
        taskId: 'task-producer',
        message: {
          id: 'message-not-allowed',
          topic: '/findings',
          type: 'finding',
          priority: 'normal',
          body: 'not declared'
        },
        deliveryIdFor: () => 'delivery-not-allowed'
      })
    ).toThrow('Step producer is not allowed to publish to topic: /findings')
  })

  it('derives the producer step from the authenticated task when publishing', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })

    const result = session.publishFromTask({
      taskId: 'task-producer',
      message: {
        id: 'message-from-task',
        topic: '/findings',
        type: 'finding',
        priority: 'high',
        body: 'derived producer'
      },
      deliveryIdFor: ({ subscriberKey }) => `delivery-${subscriberKey}`
    })

    expect(result).toEqual({ deliveryIds: ['delivery-consumer'], replayed: false })
    const delivery = session.getDelivery('delivery-consumer')
    expect(delivery?.message).toMatchObject({
      id: 'message-from-task',
      producerKey: 'producer',
      body: 'derived producer'
    })
  })

  it('replays an identical publication id without creating duplicate deliveries', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    const publish = () =>
      session.publishFromTask({
        taskId: 'task-producer',
        message: {
          id: 'publication-stable',
          topic: '/findings',
          type: 'finding',
          priority: 'normal',
          body: 'same payload'
        },
        deliveryIdFor: ({ subscriberKey }) => `delivery-${subscriberKey}`
      })

    expect(publish()).toEqual({ deliveryIds: ['delivery-consumer'], replayed: false })
    expect(publish()).toEqual({ deliveryIds: ['delivery-consumer'], replayed: true })
    expect(session.getDelivery('delivery-consumer')?.message.id).toBe('publication-stable')
  })

  it('rejects reuse of one publication id for different content', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    session.publishFromTask({
      taskId: 'task-producer',
      message: {
        id: 'publication-conflict',
        topic: '/findings',
        type: 'finding',
        priority: 'normal',
        body: 'first payload'
      },
      deliveryIdFor: () => 'delivery-first'
    })

    expect(() =>
      session.publishFromTask({
        taskId: 'task-producer',
        message: {
          id: 'publication-conflict',
          topic: '/findings',
          type: 'finding',
          priority: 'normal',
          body: 'different payload'
        },
        deliveryIdFor: () => 'delivery-second'
      })
    ).toThrow('Collaboration publication id reused with different content: publication-conflict')
    expect(session.getDelivery('delivery-first')?.message.body).toBe('first payload')
    expect(session.getDelivery('delivery-second')).toBeUndefined()
  })

  it('replays publications with no subscribers from the publication receipt', () => {
    const session = new CollaborationRuntimeSession({
      plan: {
        objective: 'No subscribers',
        maxConcurrency: 1,
        steps: [{ key: 'producer', instruction: 'Publish.', publishesTo: ['/nobody'] }]
      },
      taskIdsByStepKey: { producer: 'task-producer' },
      admissionByStepKey: {}
    })
    const input = {
      taskId: 'task-producer',
      message: {
        id: 'publication-empty',
        topic: '/nobody',
        type: 'finding',
        priority: 'normal' as const,
        body: 'nobody listens'
      },
      deliveryIdFor: () => 'unreachable'
    }

    expect(session.publishFromTask(input)).toEqual({ deliveryIds: [], replayed: false })
    expect(session.publishFromTask(input)).toEqual({ deliveryIds: [], replayed: true })
  })

  it('rejects publish attempts from tasks outside the collaboration plan', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })

    expect(() =>
      session.publishFromTask({
        taskId: 'task-attacker',
        message: {
          id: 'message-attacker',
          topic: '/findings',
          type: 'finding',
          priority: 'normal',
          body: 'spoofed'
        },
        deliveryIdFor: () => 'delivery-attacker'
      })
    ).toThrow('Unknown collaboration task: task-attacker')
  })

  it('prepares checkpoint context without acknowledging it until the task explicitly acks', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    const message = finding('message-prepare', 'prepare me')
    session.publish(message, () => 'delivery-prepare')

    const entries = session.prepareCheckpoint({
      taskId: 'task-consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10
    })

    expect(entries).toEqual([
      {
        deliveryId: 'delivery-prepare',
        deliveryAttempt: 1,
        message
      }
    ])
    expect(session.getDelivery('delivery-prepare')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 1
    })

    expect(
      session.acknowledgeCheckpoint({
        taskId: 'task-consumer',
        nowMs: 1_001,
        acknowledgements: [{ deliveryId: 'delivery-prepare', deliveryAttempt: 1 }]
      })
    ).toEqual({ ackedDeliveryIds: ['delivery-prepare'], ignoredDeliveryIds: [] })
    expect(session.getDelivery('delivery-prepare')?.state).toBe('acked')
  })

  it('does not acknowledge an attempt after its lease has expired', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })
    session.publish(finding('message-expired', 'expired'), () => 'delivery-expired')
    const [entry] = session.prepareCheckpoint({
      taskId: 'task-consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10
    })

    expect(
      session.acknowledgeCheckpoint({
        taskId: 'task-consumer',
        nowMs: 1_100,
        acknowledgements: [
          { deliveryId: entry!.deliveryId, deliveryAttempt: entry!.deliveryAttempt }
        ]
      })
    ).toEqual({ ackedDeliveryIds: [], ignoredDeliveryIds: ['delivery-expired'] })
    expect(session.getDelivery('delivery-expired')).toMatchObject({
      state: 'pending',
      deliveryAttempt: 1
    })
  })

  it('does not let one task acknowledge another subscriber delivery', () => {
    const plan: CollaborationPlan = {
      objective: 'protect subscriber ownership',
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
    session.publish(
      finding('message-shared', 'shared'),
      ({ subscriberKey }) => `delivery-${subscriberKey}`
    )
    const [entry] = session.prepareCheckpoint({
      taskId: 'task-a',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10
    })

    expect(() =>
      session.acknowledgeCheckpoint({
        taskId: 'task-b',
        nowMs: 1_001,
        acknowledgements: [
          { deliveryId: entry!.deliveryId, deliveryAttempt: entry!.deliveryAttempt }
        ]
      })
    ).toThrow('Collaboration delivery delivery-consumer-a does not belong to task task-b')
    expect(session.getDelivery('delivery-consumer-a')?.state).toBe('in_flight')
  })

  it('routes no delivery to an unsubscribed step and rejects unknown task identities', () => {
    const session = new CollaborationRuntimeSession({
      plan: PLAN,
      taskIdsByStepKey: { producer: 'task-producer', consumer: 'task-consumer' },
      admissionByStepKey: { consumer: POLICY }
    })

    expect(
      session.publish(finding('message-1', 'x'), ({ subscriberKey }) => subscriberKey)
    ).toEqual(['consumer'])
    expect(() =>
      session.prepareCheckpoint({
        taskId: 'task-missing',
        nowMs: 1_000,
        leaseMs: 100,
        limit: 10
      })
    ).toThrow('Unknown collaboration task: task-missing')
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
