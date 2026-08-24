import type { CollaborationRoutingTable } from './collaboration-routing'

export type CollaborationMessagePriority = 'normal' | 'high' | 'urgent'

export type CollaborationMessage = {
  readonly topic: string
  readonly type: string
  readonly priority: CollaborationMessagePriority
  readonly producerKey: string
  readonly body: string
}

export type CollaborationDeliveryIntent = {
  subscriberKey: string
  message: CollaborationMessage
}

export function routeCollaborationMessage(
  routing: CollaborationRoutingTable,
  message: CollaborationMessage
): readonly CollaborationDeliveryIntent[] {
  return routing.subscribersFor(message.topic).map((subscriberKey) => ({ subscriberKey, message }))
}
