import type { CollaborationPlan } from './types'

export type CollaborationRoutingTable = {
  subscribersFor(topic: string): readonly string[]
}

export function buildCollaborationRoutingTable(plan: CollaborationPlan): CollaborationRoutingTable {
  const subscribersByTopic = new Map<string, string[]>()

  for (const step of plan.steps) {
    for (const topic of new Set(step.subscribesTo ?? [])) {
      const subscribers = subscribersByTopic.get(topic) ?? []
      subscribers.push(step.key)
      subscribersByTopic.set(topic, subscribers)
    }
  }

  return {
    subscribersFor(topic) {
      return [...(subscribersByTopic.get(topic) ?? [])]
    }
  }
}
