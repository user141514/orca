import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationPlan } from '../collaboration/types'
import {
  getMissingCollaborationPublicationTopics,
  noteCollaborationPublication,
  registerCollaborationPublicationObligations,
  unregisterCollaborationPublicationObligations
} from './collaboration-publication-obligations'

describe('collaboration publication obligations', () => {
  it('tracks only required publish topics and clears them as publications succeed', () => {
    const runtime = new OrcaRuntimeService()
    const plan: CollaborationPlan = {
      objective: 'Publish required output',
      maxConcurrency: 1,
      steps: [
        {
          key: 'producer',
          instruction: 'Publish outputs.',
          publishesTo: ['/required', '/optional'],
          requiredPublishesTo: ['/required']
        }
      ]
    }

    registerCollaborationPublicationObligations(runtime, 'run-1', plan, {
      producer: 'task-producer'
    })

    expect(getMissingCollaborationPublicationTopics(runtime, 'run-1', 'task-producer')).toEqual([
      '/required'
    ])
    noteCollaborationPublication(runtime, 'run-1', 'task-producer', '/optional')
    expect(getMissingCollaborationPublicationTopics(runtime, 'run-1', 'task-producer')).toEqual([
      '/required'
    ])
    noteCollaborationPublication(runtime, 'run-1', 'task-producer', '/required')
    expect(getMissingCollaborationPublicationTopics(runtime, 'run-1', 'task-producer')).toEqual([])

    unregisterCollaborationPublicationObligations(runtime, 'run-1')
    expect(getMissingCollaborationPublicationTopics(runtime, 'run-1', 'task-producer')).toEqual([])
  })

  it('does not create completion obligations for optional publishesTo topics', () => {
    const runtime = new OrcaRuntimeService()
    registerCollaborationPublicationObligations(
      runtime,
      'run-optional',
      {
        objective: 'Optional publication',
        maxConcurrency: 1,
        steps: [
          {
            key: 'producer',
            instruction: 'May publish.',
            publishesTo: ['/optional']
          }
        ]
      },
      { producer: 'task-producer' }
    )

    expect(
      getMissingCollaborationPublicationTopics(runtime, 'run-optional', 'task-producer')
    ).toEqual([])
  })
})
