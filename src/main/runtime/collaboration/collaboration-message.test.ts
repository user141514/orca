import { describe, expect, it } from 'vitest'
import { routeCollaborationMessage, type CollaborationMessage } from './collaboration-message'
import { buildCollaborationRoutingTable } from './collaboration-routing'
import type { CollaborationPlan } from './types'

describe('routeCollaborationMessage', () => {
  it('routes a publisher message to subscribers without publisher-owned recipient targeting', () => {
    const plan: CollaborationPlan = {
      objective: 'Share architecture findings',
      maxConcurrency: 3,
      steps: [
        { key: 'researcher', instruction: 'Investigate the architecture.' },
        {
          key: 'reviewer',
          instruction: 'Review findings.',
          subscribesTo: ['/architecture/findings']
        },
        {
          key: 'writer',
          instruction: 'Write from findings.',
          subscribesTo: ['/architecture/findings']
        }
      ]
    }
    const routing = buildCollaborationRoutingTable(plan)
    const message: CollaborationMessage = {
      topic: '/architecture/findings',
      type: 'finding',
      priority: 'high',
      producerKey: 'researcher',
      body: 'Schema v31 has a compatibility risk.'
    }

    const deliveries = routeCollaborationMessage(routing, message)

    expect(deliveries).toEqual([
      { subscriberKey: 'reviewer', message },
      { subscriberKey: 'writer', message }
    ])
  })

  it('returns no delivery intents for a topic with no subscribers', () => {
    const routing = buildCollaborationRoutingTable({
      objective: 'No subscribers',
      maxConcurrency: 1,
      steps: [{ key: 'researcher', instruction: 'Investigate.' }]
    })
    const message: CollaborationMessage = {
      topic: '/architecture/findings',
      type: 'finding',
      priority: 'normal',
      producerKey: 'researcher',
      body: 'Nothing consumes this yet.'
    }

    expect(routeCollaborationMessage(routing, message)).toEqual([])
  })

  it('preserves message type and priority without applying admission policy', () => {
    const routing = buildCollaborationRoutingTable({
      objective: 'Preserve message semantics',
      maxConcurrency: 1,
      steps: [
        {
          key: 'consumer',
          instruction: 'Consume updates.',
          subscribesTo: ['/status']
        }
      ]
    })
    const message: CollaborationMessage = {
      topic: '/status',
      type: 'status',
      priority: 'urgent',
      producerKey: 'producer',
      body: 'Still working.'
    }

    const [delivery] = routeCollaborationMessage(routing, message)

    expect(delivery?.message).toBe(message)
    expect(delivery?.message.type).toBe('status')
    expect(delivery?.message.priority).toBe('urgent')
  })
})
