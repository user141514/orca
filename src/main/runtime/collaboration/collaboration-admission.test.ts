import { describe, expect, it } from 'vitest'
import { admitCollaborationDeliveries } from './collaboration-admission'
import { CollaborationMailbox } from './collaboration-mailbox'
import type { CollaborationDeliveryIntent, CollaborationMessage } from './collaboration-message'

function message(
  id: string,
  type: string,
  priority: CollaborationMessage['priority']
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

function claimedBatch(): ReturnType<CollaborationMailbox['claim']> {
  const mailbox = new CollaborationMailbox()
  mailbox.enqueue('delivery-1', intent(message('message-1', 'finding', 'normal')))
  mailbox.enqueue('delivery-2', intent(message('message-2', 'constraint', 'high')))
  mailbox.enqueue('delivery-3', intent(message('message-3', 'status', 'urgent')))
  mailbox.enqueue('delivery-4', intent(message('message-4', 'finding', 'urgent')))
  return mailbox.claim({ subscriberKey: 'consumer', nowMs: 1_000, leaseMs: 100, limit: 4 })
}

describe('admitCollaborationDeliveries', () => {
  it('filters by message type and orders admitted context by priority with FIFO ties', () => {
    const result = admitCollaborationDeliveries(claimedBatch(), {
      acceptedTypes: ['finding', 'constraint'],
      minPriority: 'normal'
    })

    expect(result.contextEntries.map((entry) => entry.deliveryId)).toEqual([
      'delivery-4',
      'delivery-2',
      'delivery-1'
    ])
    expect(result.filteredDeliveryIds).toEqual(['delivery-3'])
  })

  it('treats an empty type allow-list as a closed admission policy', () => {
    const result = admitCollaborationDeliveries(claimedBatch(), {
      acceptedTypes: [],
      minPriority: 'normal'
    })

    expect(result.contextEntries).toEqual([])
    expect(result.filteredDeliveryIds).toEqual([
      'delivery-1',
      'delivery-2',
      'delivery-3',
      'delivery-4'
    ])
  })

  it('rejects deliveries that were not claimed in-flight', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent(message('message-1', 'finding', 'normal')))

    expect(() =>
      admitCollaborationDeliveries(mailbox.pending('consumer'), {
        acceptedTypes: ['finding'],
        minPriority: 'normal'
      })
    ).toThrow('Collaboration admission requires in-flight deliveries')
  })

  it('rejects batches that mix subscriber mailboxes', () => {
    const mailbox = new CollaborationMailbox()
    const shared = message('message-1', 'finding', 'normal')
    mailbox.enqueue('delivery-a', { subscriberKey: 'consumer-a', message: shared })
    mailbox.enqueue('delivery-b', { subscriberKey: 'consumer-b', message: shared })
    const mixed = [
      ...mailbox.claim({ subscriberKey: 'consumer-a', nowMs: 1_000, leaseMs: 100, limit: 1 }),
      ...mailbox.claim({ subscriberKey: 'consumer-b', nowMs: 1_000, leaseMs: 100, limit: 1 })
    ]

    expect(() =>
      admitCollaborationDeliveries(mixed, {
        acceptedTypes: ['finding'],
        minPriority: 'normal'
      })
    ).toThrow('Collaboration admission requires a single subscriber batch')
  })

  it('filters below the minimum priority without losing delivery identity', () => {
    const result = admitCollaborationDeliveries(claimedBatch(), {
      acceptedTypes: ['finding', 'constraint', 'status'],
      minPriority: 'high'
    })

    expect(result.contextEntries.map((entry) => entry.deliveryId)).toEqual([
      'delivery-3',
      'delivery-4',
      'delivery-2'
    ])
    expect(result.contextEntries.map((entry) => entry.message.id)).toEqual([
      'message-3',
      'message-4',
      'message-2'
    ])
    expect(result.filteredDeliveryIds).toEqual(['delivery-1'])
  })
})
