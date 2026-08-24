import { describe, expect, it } from 'vitest'
import { prepareCollaborationCheckpoint } from './collaboration-checkpoint-delivery'
import { CollaborationMailbox } from './collaboration-mailbox'
import type { CollaborationDeliveryIntent, CollaborationMessage } from './collaboration-message'

function message(
  id: string,
  type: string,
  priority: CollaborationMessage['priority'] = 'normal'
): CollaborationMessage {
  return {
    id,
    topic: '/updates',
    type,
    priority,
    producerKey: 'producer',
    body: id
  }
}

function intent(message: CollaborationMessage): CollaborationDeliveryIntent {
  return { subscriberKey: 'consumer', message }
}

function mailboxWithMessages(): CollaborationMailbox {
  const mailbox = new CollaborationMailbox()
  mailbox.enqueue('delivery-finding', intent(message('message-finding', 'finding', 'high')))
  mailbox.enqueue('delivery-status', intent(message('message-status', 'status', 'urgent')))
  return mailbox
}

describe('prepareCollaborationCheckpoint', () => {
  it('replays the same unacknowledged in-flight context during the active lease', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-finding', intent(message('message-finding', 'finding', 'high')))
    const first = prepareCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' }
    })

    const replay = prepareCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_001,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' }
    })

    expect(replay).toEqual(first)
    expect(replay).toMatchObject([{ deliveryId: 'delivery-finding', deliveryAttempt: 1 }])
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 1,
      leaseUntilMs: 1_100
    })
  })

  it('acks filtered deliveries but leaves accepted context in flight with its claim attempt', () => {
    const mailbox = mailboxWithMessages()

    const entries = prepareCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' }
    })

    expect(entries).toEqual([
      {
        deliveryId: 'delivery-finding',
        deliveryAttempt: 1,
        message: expect.objectContaining({ id: 'message-finding' })
      }
    ])
    expect(mailbox.get('delivery-status')?.state).toBe('acked')
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 1,
      leaseUntilMs: 1_100
    })
  })

  it('reclaims an expired unacknowledged context as a newer delivery attempt', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-finding', intent(message('message-finding', 'finding', 'high')))
    prepareCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' }
    })

    const retried = prepareCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_100,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' }
    })

    expect(retried).toMatchObject([{ deliveryId: 'delivery-finding', deliveryAttempt: 2 }])
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 2,
      leaseUntilMs: 1_200
    })
  })
})
