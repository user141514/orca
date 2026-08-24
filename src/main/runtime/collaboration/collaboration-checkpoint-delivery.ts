import {
  admitCollaborationDeliveries,
  type CollaborationAdmissionContextEntry,
  type CollaborationAdmissionPolicy
} from './collaboration-admission'
import type { CollaborationMailbox } from './collaboration-mailbox'

export async function deliverCollaborationCheckpoint(options: {
  mailbox: CollaborationMailbox
  subscriberKey: string
  nowMs: number
  leaseMs: number
  limit: number
  policy: CollaborationAdmissionPolicy
  // At-least-once retries can commit the same deliveryId again; callers must be idempotent.
  commitContext: (entries: readonly CollaborationAdmissionContextEntry[]) => Promise<void>
}): Promise<void> {
  const claimed = options.mailbox.claim({
    subscriberKey: options.subscriberKey,
    nowMs: options.nowMs,
    leaseMs: options.leaseMs,
    limit: options.limit
  })
  if (claimed.length === 0) {
    return
  }

  const attemptByDeliveryId = new Map(
    claimed.map((delivery) => [delivery.id, delivery.deliveryAttempt] as const)
  )
  const admitted = admitCollaborationDeliveries(claimed, options.policy)
  for (const deliveryId of admitted.filteredDeliveryIds) {
    options.mailbox.ack(deliveryId, requireDeliveryAttempt(attemptByDeliveryId, deliveryId))
  }
  if (admitted.contextEntries.length === 0) {
    return
  }

  await options.commitContext(admitted.contextEntries)
  for (const entry of admitted.contextEntries) {
    options.mailbox.ack(
      entry.deliveryId,
      requireDeliveryAttempt(attemptByDeliveryId, entry.deliveryId)
    )
  }
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
