import type { CollaborationDeliveryIntent, CollaborationMessage } from './collaboration-message'

export type CollaborationDeliveryState = 'pending' | 'in_flight' | 'acked'

export type CollaborationDelivery = {
  readonly id: string
  readonly subscriberKey: string
  readonly message: CollaborationMessage
  readonly state: CollaborationDeliveryState
  readonly leaseUntilMs: number | null
  readonly deliveryAttempt: number
}

type DeliveryRecord = {
  id: string
  subscriberKey: string
  message: CollaborationMessage
  state: CollaborationDeliveryState
  leaseUntilMs: number | null
  deliveryAttempt: number
  queueOrder: number
}

export class CollaborationMailbox {
  private readonly deliveries = new Map<string, DeliveryRecord>()
  private nextQueueOrder = 0

  enqueue(deliveryId: string, intent: CollaborationDeliveryIntent): void {
    if (this.deliveries.has(deliveryId)) {
      throw new Error(`Duplicate collaboration delivery id: ${deliveryId}`)
    }
    this.deliveries.set(deliveryId, {
      id: deliveryId,
      subscriberKey: intent.subscriberKey,
      message: intent.message,
      state: 'pending',
      leaseUntilMs: null,
      deliveryAttempt: 0,
      queueOrder: this.nextQueueOrder++
    })
  }

  claim(options: {
    subscriberKey: string
    nowMs: number
    leaseMs: number
    limit: number
  }): CollaborationDelivery[] {
    if (options.limit <= 0) {
      return []
    }
    const selected = this.recordsForSubscriber(options.subscriberKey)
      .filter((delivery) => delivery.state === 'pending')
      .slice(0, Math.floor(options.limit))

    for (const delivery of selected) {
      delivery.state = 'in_flight'
      delivery.leaseUntilMs = options.nowMs + options.leaseMs
      delivery.deliveryAttempt += 1
    }
    return selected.map(toDelivery)
  }

  ack(deliveryId: string): boolean {
    const delivery = this.deliveries.get(deliveryId)
    if (!delivery || delivery.state !== 'in_flight') {
      return false
    }
    delivery.state = 'acked'
    delivery.leaseUntilMs = null
    return true
  }

  releaseExpired(nowMs: number): CollaborationDelivery[] {
    const expired = [...this.deliveries.values()]
      .filter(
        (delivery) =>
          delivery.state === 'in_flight' &&
          delivery.leaseUntilMs !== null &&
          delivery.leaseUntilMs <= nowMs
      )
      .sort((left, right) => left.queueOrder - right.queueOrder)

    for (const delivery of expired) {
      delivery.state = 'pending'
      delivery.leaseUntilMs = null
      delivery.queueOrder = this.nextQueueOrder++
    }
    return expired.map(toDelivery)
  }

  pending(subscriberKey: string): CollaborationDelivery[] {
    return this.recordsForSubscriber(subscriberKey)
      .filter((delivery) => delivery.state === 'pending')
      .map(toDelivery)
  }

  get(deliveryId: string): CollaborationDelivery | undefined {
    const delivery = this.deliveries.get(deliveryId)
    return delivery ? toDelivery(delivery) : undefined
  }

  private recordsForSubscriber(subscriberKey: string): DeliveryRecord[] {
    return [...this.deliveries.values()]
      .filter((delivery) => delivery.subscriberKey === subscriberKey)
      .sort((left, right) => left.queueOrder - right.queueOrder)
  }
}

function toDelivery(record: DeliveryRecord): CollaborationDelivery {
  return {
    id: record.id,
    subscriberKey: record.subscriberKey,
    message: record.message,
    state: record.state,
    leaseUntilMs: record.leaseUntilMs,
    deliveryAttempt: record.deliveryAttempt
  }
}
