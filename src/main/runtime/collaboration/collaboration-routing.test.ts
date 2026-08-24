import { describe, expect, it } from 'vitest'
import { buildCollaborationRoutingTable } from './collaboration-routing'
import type { CollaborationPlan } from './types'

describe('buildCollaborationRoutingTable', () => {
  it('resolves semantic topics to subscribing collaboration steps in declaration order', () => {
    const plan: CollaborationPlan = {
      objective: 'Coordinate research and review',
      maxConcurrency: 2,
      steps: [
        {
          key: 'research',
          instruction: 'Investigate the architecture.',
          subscribesTo: ['/findings']
        },
        {
          key: 'review',
          instruction: 'Review important discoveries.',
          subscribesTo: ['/findings', '/decisions']
        },
        { key: 'writer', instruction: 'Write the final draft.' }
      ]
    }

    const routing = buildCollaborationRoutingTable(plan)

    expect(routing.subscribersFor('/findings')).toEqual(['research', 'review'])
    expect(routing.subscribersFor('/decisions')).toEqual(['review'])
    expect(routing.subscribersFor('/unknown')).toEqual([])
  })

  it('does not register the same step twice for a duplicated subscription', () => {
    const plan: CollaborationPlan = {
      objective: 'Avoid duplicate deliveries',
      maxConcurrency: 1,
      steps: [
        {
          key: 'consumer',
          instruction: 'Consume findings.',
          subscribesTo: ['/findings', '/findings']
        }
      ]
    }

    const routing = buildCollaborationRoutingTable(plan)

    expect(routing.subscribersFor('/findings')).toEqual(['consumer'])
  })

  it('treats topic names as opaque strings rather than object keys or step references', () => {
    const plan: CollaborationPlan = {
      objective: 'Keep topic routing opaque',
      maxConcurrency: 1,
      steps: [
        {
          key: 'draft',
          instruction: 'Produce a draft.'
        },
        {
          key: 'consumer',
          instruction: 'Consume unusual topics.',
          subscribesTo: ['__proto__', 'constructor', 'draft', '']
        }
      ]
    }

    const routing = buildCollaborationRoutingTable(plan)

    expect(routing.subscribersFor('__proto__')).toEqual(['consumer'])
    expect(routing.subscribersFor('constructor')).toEqual(['consumer'])
    expect(routing.subscribersFor('draft')).toEqual(['consumer'])
    expect(routing.subscribersFor('')).toEqual(['consumer'])
  })
})
