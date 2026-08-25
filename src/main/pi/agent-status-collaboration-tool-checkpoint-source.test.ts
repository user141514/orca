import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import { describe, expect, it, vi } from 'vitest'
import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

type HookHandler = (event?: unknown, context?: unknown) => unknown

type Harness = {
  fetchMock: ReturnType<typeof vi.fn>
  handlers: Record<string, HookHandler>
  callHook(name: string, event?: unknown, context?: unknown): Promise<unknown>
}

const BASE_ENV = {
  ORCA_PANE_KEY: 'pane-1',
  ORCA_AGENT_LAUNCH_TOKEN: 'launch-1',
  ORCA_TAB_ID: 'tab-1',
  ORCA_WORKTREE_ID: 'tree-1',
  ORCA_AGENT_HOOK_PORT: '4321',
  ORCA_AGENT_HOOK_TOKEN: 'token-1',
  ORCA_AGENT_HOOK_ENV: 'env-1',
  ORCA_AGENT_HOOK_VERSION: '1.2.3'
} satisfies Record<string, string>

function createHarness(args: {
  kind: 'pi' | 'omp' | 'prime-agent'
  fetchImpl?: (...params: Parameters<typeof fetch>) => Promise<unknown>
}): Harness {
  const fetchMock = vi.fn(args.fetchImpl ?? (async () => ({ ok: true })))
  const module = {
    exports: {} as { default?: (pi: { on: (name: string, handler: HookHandler) => void }) => void }
  }
  const fsMock = {
    existsSync: vi.fn(() => false),
    statSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }),
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
  }
  const child = { on: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } }
  const requireMock = vi.fn((specifier: string) => {
    if (specifier === 'fs') {
      return fsMock
    }
    if (specifier === 'child_process') {
      return { spawn: vi.fn(() => child) }
    }
    throw new Error(`unexpected require(${specifier})`)
  })
  const processMock = {
    env: {
      ...BASE_ENV,
      ...(args.kind === 'prime-agent' ? { PRIME_AGENT_INTERNAL_DAEMON_WORKER: '1' } : {})
    },
    pid: 4242,
    title: 'node',
    argv: ['node', '/usr/bin/orca']
  }
  const context = {
    module,
    exports: module.exports,
    require: requireMock,
    process: processMock,
    fetch: fetchMock,
    console: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    Promise,
    Buffer,
    URL,
    AbortController,
    setTimeout,
    clearTimeout
  } as Record<string, unknown>
  context.globalThis = context

  const output = ts.transpileModule(getPiAgentStatusExtensionSource(args.kind), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }
  }).outputText
  runInNewContext(output, context)
  const register = module.exports.default
  if (!register) {
    throw new Error('expected Pi extension default export')
  }
  const handlers: Record<string, HookHandler> = {}
  register({ on: (name, handler) => (handlers[name] = handler) })
  return {
    fetchMock,
    handlers,
    callHook: async (name, event, hookContext) => await handlers[name]?.(event, hookContext)
  }
}

const TOOL_RESULT_EVENT = {
  type: 'tool_result',
  toolCallId: 'call-1',
  toolName: 'bash',
  input: { command: 'echo hello' },
  content: [{ type: 'text', text: 'original tool output' }],
  details: {},
  isError: false
}

function patchText(attempt = 1): string {
  return `original tool output\n=== COLLABORATION CONTEXT PATCH ===\ndelivery delivery-1 attempt=${attempt}\n/findings finding high producer=producer\nschema v31 is risky`
}

function providerRequestWithPatch(attempt = 1) {
  return {
    type: 'before_provider_request',
    payload: { messages: [{ role: 'tool', content: [{ type: 'text', text: patchText(attempt) }] }] }
  }
}

const ASSISTANT_MESSAGE_START = {
  type: 'message_start',
  message: { role: 'assistant', content: [] }
}

function preparedResult(attempt = 1) {
  return {
    active: true,
    entries: [
      {
        deliveryId: 'delivery-1',
        deliveryAttempt: attempt,
        message: {
          id: 'message-1',
          topic: '/findings',
          type: 'finding',
          priority: 'high',
          producerKey: 'producer',
          body: 'schema v31 is risky'
        }
      }
    ]
  }
}

function settledAck(active = true) {
  return { active, ackedDeliveryIds: active ? ['delivery-1'] : [], ignoredDeliveryIds: [] }
}

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

  it.each([
    'orca-dev collaboration checkpoint --from term_worker --task-id task_1 --dispatch-id ctx_1',
    'orca collaboration checkpoint-ack --from term_worker --task-id task_1 --dispatch-id ctx_1 --ack []',
    '/usr/local/bin/orca-ide collaboration checkpoint --from term_worker --task-id task_1 --dispatch-id ctx_1 --wait'
  ])('does not auto-prepare on explicit stage-checkpoint results: %s', async (command) => {
    const harness = createHarness({
      kind: 'pi',
      fetchImpl: vi.fn(async () => ({ ok: true, json: async () => preparedResult() }))
    })
    expect(
      await harness.callHook('tool_result', { ...TOOL_RESULT_EVENT, input: { command } })
    ).toBeUndefined()
    expect(harness.fetchMock).not.toHaveBeenCalled()
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
