import { describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_MESSAGE_START,
  TOOL_RESULT_EVENT,
  createHarness,
  preparedResult,
  providerRequestWithPatch,
  settledAck
} from './agent-status-collaboration-tool-checkpoint-test-harness'

describe('Pi collaboration tool-return checkpoint extension', () => {
  it('registers tool-return checkpoint handlers only for Pi', () => {
    const pi = createHarness({ kind: 'pi' })
    const omp = createHarness({ kind: 'omp' })
    const prime = createHarness({ kind: 'prime-agent' })
    for (const name of ['tool_result', 'before_provider_request', 'message_start']) {
      expect(pi.handlers[name]).toBeTypeOf('function')
      expect(omp.handlers[name]).toBeUndefined()
      expect(prime.handlers[name]).toBeUndefined()
    }
  })

  it('suspends auto injection while an explicit stage delivery awaits manual acknowledgement', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => preparedResult(1, 'delivery-stage')
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => preparedResult(1, 'delivery-auto')
        })
    })
    const stageResult = {
      ...TOOL_RESULT_EVENT,
      input: { command: 'orca-dev collaboration checkpoint --from term_worker' },
      content: [{ type: 'text', text: 'delivery delivery-stage attempt=1\n/findings finding' }]
    }
    expect(await harness.callHook('tool_result', stageResult)).toBeUndefined()

    const publishResult = {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-publish',
      input: { command: 'orca-dev collaboration publish --topic /review' }
    }
    expect(await harness.callHook('tool_result', publishResult)).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(String(harness.fetchMock.mock.calls[0]?.[0])).toContain('/prepare')

    const ackResult = {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-ack',
      input: { command: 'orca-dev collaboration checkpoint-ack --ack []' },
      content: [{ type: 'text', text: 'Acknowledged 1: delivery-stage' }]
    }
    expect(await harness.callHook('tool_result', ackResult)).toBeUndefined()

    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-after-ack' })
    ).toBeDefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
  })

  it('releases stale local Stage ownership after an ignored acknowledgement so auto can recover', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => preparedResult(2, 'delivery-stage')
      }))
    })
    await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      input: { command: 'orca-dev collaboration checkpoint --from term_worker' },
      content: [{ type: 'text', text: 'delivery delivery-stage attempt=1\n/findings finding' }]
    })
    await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-ignored',
      input: { command: 'orca-dev collaboration checkpoint-ack --ack []' },
      content: [{ type: 'text', text: 'Acknowledged 0\nIgnored 1: delivery-stage' }]
    })
    const recovered = (await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-recover'
    })) as { content?: { type: string; text?: string }[] }
    expect(recovered.content?.[1]?.text).toContain('delivery delivery-stage attempt=2')
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps Stage ownership when explicit checkpoint-ack fails', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => preparedResult(1, 'delivery-stage')
      }))
    })
    await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      input: { command: 'orca-dev collaboration checkpoint --from term_worker' },
      content: [{ type: 'text', text: 'delivery delivery-stage attempt=1\n/findings finding' }]
    })
    await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-ack-error',
      input: { command: 'orca-dev collaboration checkpoint-ack --ack []' },
      content: [{ type: 'text', text: 'dispatch capability invalid' }],
      isError: true
    })
    expect(
      await harness.callHook('tool_result', {
        ...TOOL_RESULT_EVENT,
        toolCallId: 'call-after-error'
      })
    ).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('tracks Stage ownership from JSON checkpoint output', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({
        ok: true,
        json: async () => preparedResult(2, 'delivery-json')
      }))
    })
    await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      input: { command: 'orca-dev collaboration checkpoint --json --from term_worker' },
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            result: {
              entries: [{ deliveryId: 'delivery-json', deliveryAttempt: 2, message: {} }]
            }
          })
        }
      ]
    })
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-after-json' })
    ).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('acks only after the patch is in provider payload and the assistant stream starts', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => preparedResult() })
        .mockResolvedValueOnce({ ok: true, json: async () => settledAck() })
    })
    const patched = (await harness.callHook('tool_result', TOOL_RESULT_EVENT)) as {
      content?: { type: string; text?: string }[]
    }
    expect(patched.content?.[1]?.text).toContain('delivery delivery-1 attempt=1')
    expect(patched.content?.[1]?.text).toContain('schema v31 is risky')
    await harness.callHook('before_provider_request', providerRequestWithPatch())
    await harness.callHook('message_start', {
      type: 'message_start',
      message: { role: 'toolResult', content: [] }
    })
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)

    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    const [ackUrl, ackOptions] = harness.fetchMock.mock.calls[1] ?? []
    expect(String(ackUrl)).toContain('/tool-checkpoint/ack')
    expect(JSON.parse(String((ackOptions as RequestInit | undefined)?.body))).toMatchObject({
      acknowledgements: [{ deliveryId: 'delivery-1', deliveryAttempt: 1 }]
    })
  })

  it('does not ack a provider request without the injected token and allows replay', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => preparedResult() }))
    })
    await harness.callHook('tool_result', TOOL_RESULT_EVENT)
    await harness.callHook('before_provider_request', {
      type: 'before_provider_request',
      payload: undefined
    })
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)
    const replay = await harness.callHook('tool_result', {
      ...TOOL_RESULT_EVENT,
      toolCallId: 'call-2'
    })

    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    expect(String(harness.fetchMock.mock.calls[1]?.[0])).toContain('/tool-checkpoint/prepare')
    expect(replay).toBeDefined()
  })

  it('retries malformed prepared entries without injecting or acknowledging them', async () => {
    const malformed = {
      active: true,
      entries: [{ deliveryId: 'delivery-1', deliveryAttempt: '1' }]
    }
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => malformed }))
    })
    expect(await harness.callHook('tool_result', TOOL_RESULT_EVENT)).toBeUndefined()
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-2' })
    ).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    expect(harness.fetchMock.mock.calls.every(([url]) => String(url).includes('/prepare'))).toBe(
      true
    )
  })

  it('does not prepare one outstanding delivery into multiple tool results', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => preparedResult() }))
    })
    expect(await harness.callHook('tool_result', TOOL_RESULT_EVENT)).toBeDefined()
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-2' })
    ).toBeUndefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries an armed acknowledgement after a transient endpoint failure', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => preparedResult() })
        .mockRejectedValueOnce(new Error('endpoint unavailable'))
        .mockResolvedValueOnce({ ok: true, json: async () => settledAck() })
    })
    await harness.callHook('tool_result', TOOL_RESULT_EVENT)
    await harness.callHook('before_provider_request', providerRequestWithPatch())
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)
    expect(harness.fetchMock).toHaveBeenCalledTimes(3)
    expect(String(harness.fetchMock.mock.calls[1]?.[0])).toContain('/tool-checkpoint/ack')
    expect(String(harness.fetchMock.mock.calls[2]?.[0])).toContain('/tool-checkpoint/ack')
  })

  it('keeps armed state when the server temporarily reports the checkpoint inactive', async () => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: async () => preparedResult() })
        .mockResolvedValueOnce({ ok: true, json: async () => settledAck(false) })
        .mockResolvedValueOnce({ ok: true, json: async () => settledAck() })
        .mockResolvedValueOnce({ ok: true, json: async () => preparedResult() })
    })
    await harness.callHook('tool_result', TOOL_RESULT_EVENT)
    await harness.callHook('before_provider_request', providerRequestWithPatch())
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-2' })
    ).toBeUndefined()
    await harness.callHook('message_start', ASSISTANT_MESSAGE_START)
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, toolCallId: 'call-3' })
    ).toBeDefined()
    expect(harness.fetchMock).toHaveBeenCalledTimes(4)
  })
})
