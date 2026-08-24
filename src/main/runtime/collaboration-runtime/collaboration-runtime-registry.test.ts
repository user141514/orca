import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { CollaborationRuntimeSession } from '../collaboration/collaboration-runtime-session'
import {
  getCollaborationRuntimeSession,
  registerCollaborationRuntimeSession,
  unregisterCollaborationRuntimeSession
} from './collaboration-runtime-registry'

function session(): CollaborationRuntimeSession {
  return new CollaborationRuntimeSession({
    plan: {
      objective: 'registry test',
      maxConcurrency: 1,
      steps: [{ key: 'worker', instruction: 'Work.' }]
    },
    taskIdsByStepKey: { worker: 'task-worker' },
    admissionByStepKey: {}
  })
}

describe('collaboration runtime registry', () => {
  it('scopes run sessions to one Orca runtime and supports explicit removal', () => {
    const runtimeA = new OrcaRuntimeService()
    const runtimeB = new OrcaRuntimeService()
    const value = session()

    registerCollaborationRuntimeSession(runtimeA, 'run-1', value)

    expect(() => registerCollaborationRuntimeSession(runtimeA, 'run-1', session())).toThrow(
      'Collaboration runtime session already registered: run-1'
    )
    expect(getCollaborationRuntimeSession(runtimeA, 'run-1')).toBe(value)
    expect(getCollaborationRuntimeSession(runtimeB, 'run-1')).toBeUndefined()
    unregisterCollaborationRuntimeSession(runtimeA, 'run-1')
    expect(getCollaborationRuntimeSession(runtimeA, 'run-1')).toBeUndefined()
  })
})
