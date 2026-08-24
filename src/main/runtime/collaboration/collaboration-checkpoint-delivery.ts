import {
  admitCollaborationDeliveries,
  type CollaborationAdmissionPolicy
} from './collaboration-admission'
import type { CollaborationMailbox } from './collaboration-mailbox'
import type { CollaborationMessage } from './collaboration-message'

export type CollaborationPreparedContextEntry = {
  readonly deliveryId: string
  readonly deliveryAttempt: number
  readonly message: CollaborationMessage
}

export function prepareCollaborationCheckpoint(options: {
  mailbox: CollaborationMailbox
  subscriberKey: string
  nowMs: number
  leaseMs: number
  limit: number
  policy: CollaborationAdmissionPolicy
}): readonly CollaborationPreparedContextEntry[] {
  options.mailbox.releaseExpired(options.nowMs)
  const outstanding = options.mailbox.inFlight(options.subscriberKey)
  if (outstanding.length > 0) {
    return outstanding.map((delivery) => ({
      deliveryId: delivery.id,
      deliveryAttempt: delivery.deliveryAttempt,
      message: delivery.message
    }))
  }

  const claimed = options.mailbox.claim({
    subscriberKey: options.subscriberKey,
    nowMs: options.nowMs,
    leaseMs: options.leaseMs,
    limit: options.limit
  })
  if (claimed.length === 0) {
    return []
  }

  const attemptByDeliveryId = new Map(
    claimed.map((delivery) => [delivery.id, delivery.deliveryAttempt] as const)
  )
  const admitted = admitCollaborationDeliveries(claimed, options.policy)
  for (const deliveryId of admitted.filteredDeliveryIds) {
    options.mailbox.ack(deliveryId, requireDeliveryAttempt(attemptByDeliveryId, deliveryId))
  }
  return admitted.contextEntries.map((entry) => ({
    deliveryId: entry.deliveryId,
    deliveryAttempt: requireDeliveryAttempt(attemptByDeliveryId, entry.deliveryId),
    message: entry.message
  }))
}

function requireDeliveryAttempt(
  attemptByDeliveryId: ReadonlyMap<string, number>,
  deliveryId: string
): number {
  const attempt = attemptByDeliveryId.get(deliveryId)
  if (attempt === undefined) {
    throw new Error(`Collaboration checkpoint missing delivery attempt: ${deliveryId}`)
  }
  return attempt
}
