import { describe, expect, it } from 'vitest'
import type { CollaborationDeliveryIntent, CollaborationMessage } from './collaboration-message'
import { CollaborationMailbox } from './collaboration-mailbox'

function message(id: string, body: string): CollaborationMessage {
  return {
    id,
    topic: '/findings',
    type: 'finding',
    priority: 'normal',
    producerKey: 'producer',
    body
  }
}

function intent(subscriberKey: string, value: CollaborationMessage): CollaborationDeliveryIntent {
  return { subscriberKey, message: value }
}

describe('CollaborationMailbox', () => {
  it('claims pending deliveries in FIFO order and acknowledges only after processing', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent('consumer', message('message-1', 'first')))
    mailbox.enqueue('delivery-2', intent('consumer', message('message-2', 'second')))

    const claimed = mailbox.claim({
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 500,
      limit: 2
    })

    expect(claimed.map((delivery) => delivery.id)).toEqual(['delivery-1', 'delivery-2'])
    expect(claimed.every((delivery) => delivery.state === 'in_flight')).toBe(true)
    expect(claimed.every((delivery) => delivery.leaseUntilMs === 1_500)).toBe(true)
    expect(claimed.every((delivery) => delivery.deliveryAttempt === 1)).toBe(true)
    expect(mailbox.pending('consumer')).toEqual([])

    mailbox.ack('delivery-1')

    expect(mailbox.get('delivery-1')).toMatchObject({ state: 'acked', leaseUntilMs: null })
    expect(mailbox.get('delivery-2')).toMatchObject({ state: 'in_flight', leaseUntilMs: 1_500 })
  })

  it('returns expired in-flight deliveries to pending for at-least-once redelivery', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent('consumer', message('message-1', 'retry me')))
    mailbox.claim({ subscriberKey: 'consumer', nowMs: 1_000, leaseMs: 100, limit: 1 })

    expect(mailbox.releaseExpired(1_099)).toEqual([])
    expect(mailbox.releaseExpired(1_100).map((delivery) => delivery.id)).toEqual(['delivery-1'])
    expect(mailbox.get('delivery-1')).toMatchObject({ state: 'pending', leaseUntilMs: null })

    const retried = mailbox.claim({
      subscriberKey: 'consumer',
      nowMs: 1_101,
      leaseMs: 100,
      limit: 1
    })
    expect(retried).toHaveLength(1)
    expect(retried[0]).toMatchObject({
      id: 'delivery-1',
      state: 'in_flight',
      deliveryAttempt: 2
    })
  })

  it('keeps one immutable message identity across independent subscriber deliveries', () => {
    const mailbox = new CollaborationMailbox()
    const shared = message('message-1', 'shared')
    mailbox.enqueue('delivery-b', intent('consumer-b', shared))
    mailbox.enqueue('delivery-c', intent('consumer-c', shared))

    mailbox.claim({ subscriberKey: 'consumer-b', nowMs: 1_000, leaseMs: 100, limit: 1 })
    mailbox.ack('delivery-b')

    expect(mailbox.get('delivery-b')).toMatchObject({ state: 'acked' })
    expect(mailbox.get('delivery-c')).toMatchObject({ state: 'pending' })
    expect(mailbox.get('delivery-b')?.message).toBe(shared)
    expect(mailbox.get('delivery-c')?.message).toBe(shared)
  })

  it('rejects duplicate delivery ids and treats duplicate or premature acknowledgements as no-ops', () => {
    const mailbox = new CollaborationMailbox()
    const delivery = intent('consumer', message('message-1', 'once'))
    mailbox.enqueue('delivery-1', delivery)

    expect(() => mailbox.enqueue('delivery-1', delivery)).toThrow(
      'Duplicate collaboration delivery id'
    )
    expect(mailbox.ack('delivery-1')).toBe(false)

    mailbox.claim({ subscriberKey: 'consumer', nowMs: 1_000, leaseMs: 100, limit: 1 })
    expect(mailbox.ack('delivery-1')).toBe(true)
    expect(mailbox.ack('delivery-1')).toBe(false)
    expect(mailbox.releaseExpired(2_000)).toEqual([])
  })

  it('returns delivery snapshots that cannot mutate mailbox bookkeeping', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent('consumer', message('message-1', 'immutable wrapper')))
    const [claimed] = mailbox.claim({
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 1
    })

    const unsafe = claimed as unknown as { state: string; leaseUntilMs: number | null }
    unsafe.state = 'acked'
    unsafe.leaseUntilMs = null

    expect(mailbox.get('delivery-1')).toMatchObject({
      state: 'in_flight',
      leaseUntilMs: 1_100
    })
  })

  it('rejects stale acknowledgements from an expired prior delivery attempt', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent('consumer', message('message-1', 'retry')))

    const [firstAttempt] = mailbox.claim({
      subscriberKey: 'consumer',
      nowMs: 1_000,
      leaseMs: 100,
      limit: 1
    })
    mailbox.releaseExpired(1_100)
    const [secondAttempt] = mailbox.claim({
      subscriberKey: 'consumer',
      nowMs: 1_101,
      leaseMs: 100,
      limit: 1
    })

    expect(mailbox.ack('delivery-1', firstAttempt!.deliveryAttempt)).toBe(false)
    expect(mailbox.get('delivery-1')).toMatchObject({
      state: 'in_flight',
      deliveryAttempt: 2
    })
    expect(mailbox.ack('delivery-1', secondAttempt!.deliveryAttempt)).toBe(true)
  })

  it('requeues expired deliveries at the tail of the subscriber FIFO', () => {
    const mailbox = new CollaborationMailbox()
    mailbox.enqueue('delivery-1', intent('consumer', message('message-1', 'first')))
    mailbox.enqueue('delivery-2', intent('consumer', message('message-2', 'second')))

    mailbox.claim({ subscriberKey: 'consumer', nowMs: 1_000, leaseMs: 100, limit: 1 })
    mailbox.releaseExpired(1_100)

    expect(mailbox.pending('consumer').map((delivery) => delivery.id)).toEqual([
      'delivery-2',
      'delivery-1'
    ])
  })
})
