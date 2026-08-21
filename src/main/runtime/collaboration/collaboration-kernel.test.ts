import { describe, expect, it } from 'vitest'
import { CollaborationKernel } from './collaboration-kernel'
import type { CollaborationExecutionPort } from './collaboration-execution-port'
import type { CollaborationPlan } from './types'

describe('CollaborationKernel', () => {
  it('delegates a semantic collaboration plan through the execution port', async () => {
    const plan: CollaborationPlan = {
      objective: 'Produce and review one draft',
      maxConcurrency: 2,
      steps: [
        { key: 'draft', instruction: 'Produce the first draft.' },
        { key: 'review', instruction: 'Review the first draft.' }
      ]
    }
    let received: CollaborationPlan | undefined
    const execution: CollaborationExecutionPort = {
      start: async (input) => {
        received = input
        return { runId: 'collab_run_1' }
      }
    }
    const kernel = new CollaborationKernel(execution)

    const receipt = await kernel.start(plan)

    expect(received).toEqual(plan)
    expect(receipt).toEqual({ runId: 'collab_run_1' })
  })
})
