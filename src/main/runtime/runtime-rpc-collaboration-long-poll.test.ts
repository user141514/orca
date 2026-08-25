import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CollaborationRuntimeSession } from './collaboration/collaboration-runtime-session'
import { registerCollaborationRuntimeSession } from './collaboration-runtime/collaboration-runtime-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { OrchestrationDb } from './orchestration/db'
import { readRuntimeMetadata } from './runtime-metadata'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { openFramedSession } from './runtime-rpc-test-harness'

let db: OrchestrationDb | undefined

afterEach(() => {
  vi.restoreAllMocks()
  db?.close()
  db = undefined
})

describe('collaboration checkpoint long-poll transport', () => {
  it('emits keepalive frames while a collaboration checkpoint waits', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-collaboration-wait-'))
    const runtime = new OrcaRuntimeService()
    db = new OrchestrationDb(':memory:')
    runtime.setOrchestrationDb(db)
    const run = db.createRun({ objective: 'wait for collaboration context' })
    const task = db.createTask({ runId: run.id, spec: 'Consume findings.' })
    const paneKey = 'tab_consumer:leaf_consumer'
    const processIncarnation = 'runtime_test:term_consumer:1'
    const dispatch = db.createDispatchContext(
      task.id,
      'term_consumer',
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
    registerCollaborationRuntimeSession(
      runtime,
      run.id,
      new CollaborationRuntimeSession({
        plan: {
          objective: 'wait for collaboration context',
          maxConcurrency: 1,
          steps: [
            {
              key: 'consumer',
              instruction: 'Consume findings.',
              subscribesTo: ['/findings']
            }
          ]
        },
        taskIdsByStepKey: { consumer: task.id },
        admissionByStepKey: {
          consumer: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      })
    )
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      keepaliveIntervalMs: 30
    })
    await server.start()

    try {
      const metadata = readRuntimeMetadata(userDataPath)
      const session = openFramedSession(metadata!.transports[0]!.endpoint, {
        id: 'req_collaboration_wait',
        authToken: metadata!.authToken,
        method: 'collaboration.checkpoint',
        params: {
          from: 'term_consumer',
          taskId: task.id,
          dispatchId: dispatch.id,
          wait: true,
          timeoutMs: 160
        },
        orchestrationCapability: capability
      })
      await session.done

      const keepalives = session.frames.filter((frame) => frame._keepalive === true)
      const terminals = session.frames.filter((frame) => frame.ok !== undefined)
      expect(terminals).toHaveLength(1)
      expect(terminals[0]).toMatchObject({
        id: 'req_collaboration_wait',
        ok: true,
        result: { timedOut: true }
      })
      expect(keepalives.length).toBeGreaterThanOrEqual(3)
    } finally {
      await server.stop()
    }
  })
})
