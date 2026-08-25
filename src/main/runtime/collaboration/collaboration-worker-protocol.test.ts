import { describe, expect, it } from 'vitest'
import { buildCollaborationWorkerProtocol } from './collaboration-worker-protocol'

describe('buildCollaborationWorkerProtocol', () => {
  const authority = {
    cli: 'orca-dev',
    workerHandle: 'term_worker',
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    dispatchCapability: 'dcap_secret'
  }

  it('teaches producers only their declared topics and the stable publication retry rule', () => {
    const result = buildCollaborationWorkerProtocol({
      ...authority,
      publishesTo: ['/findings'],
      subscribesTo: []
    })

    expect(result).toContain('=== COLLABORATION PROTOCOL ===')
    expect(result).toContain('Allowed publish topics: /findings')
    expect(result).toContain('orca-dev collaboration publish')
    expect(result).toContain('--from term_worker --dispatch-capability dcap_secret')
    expect(result).toContain('--task-id task_1 --dispatch-id ctx_1')
    expect(result).toContain('--publication-id')
    expect(result).toContain(
      'reuse the SAME publication-id with identical topic/type/priority/body'
    )
    expect(result).not.toContain('collaboration checkpoint --from')
  })

  it('teaches subscribers stage checkpoints and explicit delivery epoch acknowledgement without polling', () => {
    const result = buildCollaborationWorkerProtocol({
      ...authority,
      publishesTo: [],
      subscribesTo: ['/findings']
    })

    expect(result).toContain('Subscribed topics: /findings')
    expect(result).toContain('orca-dev collaboration checkpoint --from term_worker')
    expect(result).toContain('orca-dev collaboration checkpoint-ack --from term_worker')
    expect(result).toContain('deliveryId')
    expect(result).toContain('deliveryAttempt')
    expect(result).toContain('Never poll or loop on checkpoint')
    expect(result).toContain('orca-dev collaboration checkpoint --from term_worker')
    expect(result).toContain('--wait --timeout-ms 60000')
    expect(result).toContain('if required collaboration data has not arrived')
    expect(result).toContain(
      'If after that blocking checkpoint your assignment still requires the missing collaboration data, do not report success'
    )
    expect(result).toContain('acknowledge only after you have incorporated the returned entries')
    expect(result).not.toContain('collaboration publish --from')
  })

  it('returns no extension for a worker with no collaboration topics', () => {
    expect(
      buildCollaborationWorkerProtocol({
        ...authority,
        publishesTo: [],
        subscribesTo: []
      })
    ).toBe('')
  })
})
