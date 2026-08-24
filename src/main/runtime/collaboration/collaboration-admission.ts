import type { CollaborationDelivery } from './collaboration-mailbox'
import type { CollaborationMessage } from './collaboration-message'
import type { CollaborationMessagePriority } from './collaboration-message'

export type CollaborationAdmissionPolicy = {
  readonly acceptedTypes: readonly string[]
  readonly minPriority: CollaborationMessagePriority
}

export type CollaborationAdmissionContextEntry = {
  readonly deliveryId: string
  readonly message: CollaborationMessage
}

export type CollaborationAdmissionResult = {
  readonly contextEntries: readonly CollaborationAdmissionContextEntry[]
  readonly filteredDeliveryIds: readonly string[]
}

type AdmissionCandidate = {
  index: number
  delivery: CollaborationDelivery
}

const PRIORITY_RANK: Record<CollaborationMessagePriority, number> = {
  normal: 0,
  high: 1,
  urgent: 2
}

export function admitCollaborationDeliveries(
  deliveries: readonly CollaborationDelivery[],
  policy: CollaborationAdmissionPolicy
): CollaborationAdmissionResult {
  assertAdmissionBatch(deliveries)
  const acceptedTypes = new Set(policy.acceptedTypes)
  const minPriority = PRIORITY_RANK[policy.minPriority]
  const accepted: AdmissionCandidate[] = []
  const filteredDeliveryIds: string[] = []

  for (const [index, delivery] of deliveries.entries()) {
    const admitted =
      acceptedTypes.has(delivery.message.type) &&
      PRIORITY_RANK[delivery.message.priority] >= minPriority
    if (admitted) {
      accepted.push({ index, delivery })
    } else {
      filteredDeliveryIds.push(delivery.id)
    }
  }

  accepted.sort(compareAdmissionCandidates)

  return {
    contextEntries: accepted.map(({ delivery }) => ({
      deliveryId: delivery.id,
      message: delivery.message
    })),
    filteredDeliveryIds
  }
}

function assertAdmissionBatch(deliveries: readonly CollaborationDelivery[]): void {
  const subscriberKey = deliveries[0]?.subscriberKey
  for (const delivery of deliveries) {
    if (delivery.state !== 'in_flight') {
      throw new Error('Collaboration admission requires in-flight deliveries')
    }
    if (subscriberKey !== undefined && delivery.subscriberKey !== subscriberKey) {
      throw new Error('Collaboration admission requires a single subscriber batch')
    }
  }
}

function compareAdmissionCandidates(left: AdmissionCandidate, right: AdmissionCandidate): number {
  const leftPriority = PRIORITY_RANK[left.delivery.message.priority]
  const rightPriority = PRIORITY_RANK[right.delivery.message.priority]
  return rightPriority - leftPriority || left.index - right.index
}
