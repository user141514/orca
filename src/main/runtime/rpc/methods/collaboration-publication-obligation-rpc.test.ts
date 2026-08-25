import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from '../core'
import {
  getMissingCollaborationPublicationTopics,
  registerCollaborationPublicationObligations,
  unregisterCollaborationPublicationObligations
} from '../../collaboration-runtime/collaboration-publication-obligations'
import { CollaborationRuntimeSession } from '../../collaboration/collaboration-runtime-session'
import {
  registerCollaborationRuntimeSession,
  unregisterCollaborationRuntimeSession
} from '../../collaboration-runtime/collaboration-runtime-registry'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { COLLABORATION_METHODS } from './collaboration'

let db: OrchestrationDb | undefined
let runtime: OrcaRuntimeService | undefined
let runId: string | undefined

afterEach(() => {
  if (runtime && runId) {
    unregisterCollaborationRuntimeSession(runtime, runId)
    unregisterCollaborationPublicationObligations(runtime, runId)
  }
  vi.restoreAllMocks()
  db?.close()
  db = undefined
  runtime = undefined
  runId = undefined
})

describe('collaboration.publish completion obligations', () => {
  it('marks a required publish topic only after the authenticated publish succeeds', async () => {
    db = new OrchestrationDb(':memory:')
    runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'required publication' })
    runId = run.id
    const task = db.createTask({ runId: run.id, spec: 'Publish a finding.' })
    const paneKey = 'tab_producer:leaf_producer'
    const processIncarnation = 'runtime_test:term_producer:1'
    const dispatch = db.createDispatchContext(
      task.id,
      'term_producer',
      paneKey,
      undefined,
      processIncarnation
    )
    const capability = db.mintDispatchCapability({
      dispatchId: dispatch.id,
      paneKey,
      processIncarnation
    })
    vi.spyOn(runtime, 'getTerminalPaneKey').mockReturnValue(paneKey)
    vi.spyOn(runtime, 'getTerminalProcessIncarnation').mockReturnValue(processIncarnation)

    const plan = {
      objective: 'required publication',
      maxConcurrency: 1,
      steps: [
        {
          key: 'producer',
          instruction: 'Publish a finding.',
          publishesTo: ['/findings'],
          requiredPublishesTo: ['/findings']
        }
      ]
    }
    registerCollaborationRuntimeSession(
      runtime,
      run.id,
      new CollaborationRuntimeSession({
        plan,
        taskIdsByStepKey: { producer: task.id },
        admissionByStepKey: {}
      })
    )
    registerCollaborationPublicationObligations(runtime, run.id, plan, {
      producer: task.id
    })

    expect(getMissingCollaborationPublicationTopics(runtime, run.id, task.id)).toEqual([
      '/findings'
    ])

    const method = COLLABORATION_METHODS.find(
      (candidate) => candidate.name === 'collaboration.publish'
    )
    if (!method) {
      throw new Error('collaboration.publish not registered')
    }
    const params = method.params?.parse({
      from: 'term_producer',
      taskId: task.id,
      dispatchId: dispatch.id,
      publicationId: 'required-finding-1',
      topic: '/findings',
      type: 'finding',
      priority: 'normal',
      body: 'ready'
    })
    await expect(
      method.handler(params, {
        runtime,
        orchestrationCapability: capability
      } as RpcContext)
    ).resolves.toMatchObject({ replayed: false })

    expect(getMissingCollaborationPublicationTopics(runtime, run.id, task.id)).toEqual([])
  })
})
