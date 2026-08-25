import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { COLLABORATION_HANDLERS } from './collaboration'

const log = vi.spyOn(console, 'log').mockImplementation(() => {})

afterEach(() => {
  log.mockClear()
})

describe('collaboration CLI handlers', () => {
  it('publishes with stable publication identity and Dispatch capability in the RPC envelope', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        messageId: 'pub-1',
        deliveryIds: ['delivery-1'],
        replayed: false
      }
    })
    const client = { call } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration publish']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        ['publication-id', 'pub-1'],
        ['topic', '/findings'],
        ['type', 'finding'],
        ['priority', 'high'],
        ['body', 'schema v31 is risky']
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(call).toHaveBeenCalledWith(
      'collaboration.publish',
      {
        from: 'term_worker',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        publicationId: 'pub-1',
        topic: '/findings',
        type: 'finding',
        priority: 'high',
        body: 'schema v31 is risky'
      },
      { orchestrationCapability: 'dcap_secret' }
    )
    expect(log.mock.calls.flat().join('\n')).toContain(
      'Published pub-1 to 1 subscriber: delivery-1'
    )
  })

  it('surfaces replayed zero-subscriber publications without changing their identity', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        messageId: 'pub-empty',
        deliveryIds: [],
        replayed: true
      }
    })
    const client = { call } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration publish']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        ['publication-id', 'pub-empty'],
        ['topic', '/unused'],
        ['type', 'finding'],
        ['priority', 'normal'],
        ['body', 'no subscribers']
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(log.mock.calls.flat().join('\n')).toContain('Replayed pub-empty to 0 subscribers.')
  })

  it('rejects an invalid publish priority before calling the runtime', async () => {
    const call = vi.fn()
    const client = { call } as unknown as RuntimeClient

    await expect(
      COLLABORATION_HANDLERS['collaboration publish']({
        flags: new Map([
          ['from', 'term_worker'],
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1'],
          ['dispatch-capability', 'dcap_secret'],
          ['publication-id', 'pub-invalid'],
          ['topic', '/findings'],
          ['type', 'finding'],
          ['priority', 'critical'],
          ['body', 'bad priority']
        ]),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('propagates publication conflict failures from the runtime', async () => {
    const conflict = Object.assign(new Error('publication conflict'), {
      code: 'collaboration_publication_conflict'
    })
    const call = vi.fn().mockRejectedValue(conflict)
    const client = { call } as unknown as RuntimeClient

    await expect(
      COLLABORATION_HANDLERS['collaboration publish']({
        flags: new Map([
          ['from', 'term_worker'],
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1'],
          ['dispatch-capability', 'dcap_secret'],
          ['publication-id', 'pub-conflict'],
          ['topic', '/findings'],
          ['type', 'finding'],
          ['priority', 'normal'],
          ['body', 'changed content']
        ]),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toBe(conflict)
  })

  it('rejects a missing publication id before calling the runtime', async () => {
    const call = vi.fn()
    const client = { call } as unknown as RuntimeClient

    await expect(
      COLLABORATION_HANDLERS['collaboration publish']({
        flags: new Map([
          ['from', 'term_worker'],
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1'],
          ['dispatch-capability', 'dcap_secret'],
          ['topic', '/findings'],
          ['type', 'finding'],
          ['priority', 'normal'],
          ['body', 'missing identity']
        ]),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('calls checkpoint with Dispatch identity and passes the capability in the RPC envelope', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        entries: [
          {
            deliveryId: 'delivery-1',
            deliveryAttempt: 2,
            message: {
              id: 'message-1',
              topic: '/findings',
              type: 'finding',
              priority: 'high',
              producerKey: 'producer',
              body: 'Use this finding.'
            }
          }
        ]
      }
    })
    const client = { call } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration checkpoint']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret']
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(call).toHaveBeenCalledWith(
      'collaboration.checkpoint',
      {
        from: 'term_worker',
        taskId: 'task_1',
        dispatchId: 'ctx_1'
      },
      { orchestrationCapability: 'dcap_secret' }
    )
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('delivery-1 attempt=2')
    expect(output).toContain('/findings finding high producer=producer')
    expect(output).toContain('Use this finding.')
  })

  it('escapes terminal control characters from collaboration message bodies', async () => {
    const call = vi.fn().mockResolvedValue({
      result: {
        entries: [
          {
            deliveryId: 'delivery-hostile',
            deliveryAttempt: 1,
            message: {
              id: 'message-hostile',
              topic: '/findings',
              type: 'finding',
              priority: 'normal',
              producerKey: 'producer',
              body: `safe\n\u001b[31mred\u009btab\tend`
            }
          }
        ]
      }
    })
    const client = { call } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration checkpoint']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret']
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('\\x1b[31mred\\x9btab\\x09end')
    expect(output).not.toContain('\u001b')
    expect(output).not.toContain('\u009b')
  })

  it('prints the checkpoint RPC structure unchanged in json mode', async () => {
    const response = {
      result: {
        entries: [
          {
            deliveryId: 'delivery-1',
            deliveryAttempt: 1,
            message: {
              id: 'message-1',
              topic: '/findings',
              type: 'finding',
              priority: 'normal',
              producerKey: 'producer',
              body: 'context'
            }
          }
        ]
      }
    }
    const client = { call: vi.fn().mockResolvedValue(response) } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration checkpoint']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret']
      ]),
      client,
      cwd: '/tmp/repo',
      json: true
    })

    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual(response)
  })

  it('parses acknowledgement epochs and sends them with the same Dispatch authority', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { ackedDeliveryIds: ['delivery-1'], ignoredDeliveryIds: ['delivery-stale'] }
    })
    const client = { call } as unknown as RuntimeClient

    await COLLABORATION_HANDLERS['collaboration checkpoint-ack']({
      flags: new Map([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        ['ack', JSON.stringify([{ deliveryId: 'delivery-1', deliveryAttempt: 2 }])]
      ]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(call).toHaveBeenCalledWith(
      'collaboration.checkpoint-ack',
      {
        from: 'term_worker',
        taskId: 'task_1',
        dispatchId: 'ctx_1',
        acknowledgements: [{ deliveryId: 'delivery-1', deliveryAttempt: 2 }]
      },
      { orchestrationCapability: 'dcap_secret' }
    )
    const output = log.mock.calls.flat().join('\n')
    expect(output).toContain('Acknowledged 1: delivery-1')
    expect(output).toContain('Ignored 1: delivery-stale')
  })

  it('accepts at most 50 acknowledgement epochs and rejects the 51st before RPC', async () => {
    const call = vi.fn().mockResolvedValue({
      result: { ackedDeliveryIds: [], ignoredDeliveryIds: [] }
    })
    const client = { call } as unknown as RuntimeClient
    const flags = (count: number) =>
      new Map<string, string | boolean>([
        ['from', 'term_worker'],
        ['task-id', 'task_1'],
        ['dispatch-id', 'ctx_1'],
        ['dispatch-capability', 'dcap_secret'],
        [
          'ack',
          JSON.stringify(
            Array.from({ length: count }, (_, index) => ({
              deliveryId: `delivery-${index}`,
              deliveryAttempt: 1
            }))
          )
        ]
      ])

    await COLLABORATION_HANDLERS['collaboration checkpoint-ack']({
      flags: flags(50),
      client,
      cwd: '/tmp/repo',
      json: false
    })
    expect(call).toHaveBeenCalledTimes(1)

    await expect(
      COLLABORATION_HANDLERS['collaboration checkpoint-ack']({
        flags: flags(51),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing Dispatch capability before calling the runtime', async () => {
    const call = vi.fn()
    const client = { call } as unknown as RuntimeClient

    await expect(
      COLLABORATION_HANDLERS['collaboration checkpoint']({
        flags: new Map([
          ['from', 'term_worker'],
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1']
        ]),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })

  it('rejects malformed acknowledgement JSON before calling the runtime', async () => {
    const call = vi.fn()
    const client = { call } as unknown as RuntimeClient

    await expect(
      COLLABORATION_HANDLERS['collaboration checkpoint-ack']({
        flags: new Map([
          ['from', 'term_worker'],
          ['task-id', 'task_1'],
          ['dispatch-id', 'ctx_1'],
          ['dispatch-capability', 'dcap_secret'],
          ['ack', '[{"deliveryId":"delivery-1"}]']
        ]),
        client,
        cwd: '/tmp/repo',
        json: false
      })
    ).rejects.toMatchObject({ code: 'invalid_argument' })
    expect(call).not.toHaveBeenCalled()
  })
})
