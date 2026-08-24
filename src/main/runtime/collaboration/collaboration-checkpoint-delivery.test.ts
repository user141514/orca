import { describe, expect, it, vi } from 'vitest'
import type { CollaborationAdmissionContextEntry } from './collaboration-admission'
import { deliverCollaborationCheckpoint } from './collaboration-checkpoint-delivery'
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

describe('deliverCollaborationCheckpoint', () => {
  it('acks filtered deliveries before commit and accepted deliveries only after commit succeeds', async () => {
    const mailbox = mailboxWithMessages()
    const observed: CollaborationAdmissionContextEntry[][] = []
    const commitContext = vi.fn(async (entries: readonly CollaborationAdmissionContextEntry[]) => {
      observed.push([...entries])
      expect(mailbox.get('delivery-status')?.state).toBe('acked')
      expect(mailbox.get('delivery-finding')?.state).toBe('in_flight')
    })

    await deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext
    })

    expect(commitContext).toHaveBeenCalledTimes(1)
    expect(observed[0]?.map((entry) => entry.deliveryId)).toEqual(['delivery-finding'])
    expect(mailbox.get('delivery-status')?.state).toBe('acked')
    expect(mailbox.get('delivery-finding')?.state).toBe('acked')
  })

  it('leaves accepted deliveries in flight when context commit fails so lease expiry can retry them', async () => {
    const mailbox = mailboxWithMessages()
    const commitError = new Error('context commit failed')

    await expect(
      deliverCollaborationCheckpoint({
        mailbox,
        subscriberKey: 'consumer',
        nowMs: 1_000,
        leaseMs: 100,
        limit: 10,
        policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
        commitContext: async () => {
          throw commitError
        }
      })
    ).rejects.toBe(commitError)

    expect(mailbox.get('delivery-status')?.state).toBe('acked')
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      leaseUntilMs: 1_100
    })

    expect(mailbox.releaseExpired(1_100).map((delivery) => delivery.id)).toEqual([
      'delivery-finding'
    ])
    expect(mailbox.get('delivery-finding')?.state).toBe('pending')
  })

  it('redelivers an accepted delivery after commit failure and lease expiry', async () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-finding', intent(message('message-finding', 'finding', 'high')))
    let attempt = 0
    const committedIds: string[][] = []
    const commitContext = vi.fn(async (entries: readonly CollaborationAdmissionContextEntry[]) => {
      attempt += 1
      committedIds.push(entries.map((entry) => entry.deliveryId))
      if (attempt === 1) {
        throw new Error('first commit failed')
      }
    })

    await expect(
      deliverCollaborationCheckpoint({
        mailbox,
        subscriberKey: 'consumer',
        nowMs: 1_000,
        leaseMs: 100,
        limit: 10,
        policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
        commitContext
      })
    ).rejects.toThrow('first commit failed')

    mailbox.releaseExpired(1_100)
    await deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_101,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext
    })

    expect(commitContext).toHaveBeenCalledTimes(2)
    expect(committedIds).toEqual([['delivery-finding'], ['delivery-finding']])
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'acked',
      deliveryAttempt: 2,
      leaseUntilMs: null
    })
  })

  it('does not let a stale checkpoint acknowledge a newer delivery attempt', async () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-finding', intent(message('message-finding', 'finding', 'high')))
    let releaseFirstCommit!: () => void
    const firstCommitGate = new Promise<void>((resolve) => {
      releaseFirstCommit = resolve
    })
    let firstCommitStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      firstCommitStarted = resolve
    })
    let rejectSecondCommit!: (error: Error) => void
    const secondCommitGate = new Promise<void>((_resolve, reject) => {
      rejectSecondCommit = reject
    })
    let secondCommitStarted!: () => void
    const secondStarted = new Promise<void>((resolve) => {
      secondCommitStarted = resolve
    })

    const firstCheckpoint = deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext: async () => {
        firstCommitStarted()
        await firstCommitGate
      }
    })
    await firstStarted
    mailbox.releaseExpired(1_100)

    const secondError = new Error('second commit failed')
    const secondCheckpoint = deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_101,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext: async () => {
        secondCommitStarted()
        await secondCommitGate
      }
    })
    await secondStarted
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 2
    })

    releaseFirstCommit()
    await firstCheckpoint
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 2
    })

    rejectSecondCommit(secondError)
    await expect(secondCheckpoint).rejects.toBe(secondError)
    expect(mailbox.get('delivery-finding')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 2
    })
    expect(mailbox.releaseExpired(1_201).map((delivery) => delivery.id)).toEqual([
      'delivery-finding'
    ])
    expect(mailbox.get('delivery-finding')?.state).toBe('pending')
  })

  it('drains filtered-only checkpoints without invoking the context committer', async () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-status', intent(message('message-status', 'status')))
    const commitContext = vi.fn(async () => {})

    await deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext
    })

    expect(commitContext).not.toHaveBeenCalled()
    expect(mailbox.get('delivery-status')?.state).toBe('acked')
  })

  it('does nothing when the subscriber mailbox has no pending deliveries', async () => {
    const mailbox = new CollaborationMailbox()
    const commitContext = vi.fn(async () => {})

    await deliverCollaborationCheckpoint({
      mailbox,
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 10,
      policy: { acceptedTypes: ['finding'], minPriority: 'normal' },
      commitContext
    })

    expect(commitContext).not.toHaveBeenCalled()
  })
})
