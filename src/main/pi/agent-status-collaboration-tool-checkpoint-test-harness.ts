import { runInNewContext } from 'node:vm'
import ts from 'typescript-api'
import { vi } from 'vitest'
import { getPiAgentStatusExtensionSource } from './agent-status-extension-source'

export type HookHandler = (event?: unknown, context?: unknown) => unknown

export type Harness = {
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

export function createHarness(args: {
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

export const TOOL_RESULT_EVENT = {
  type: 'tool_result',
  toolCallId: 'call-1',
  toolName: 'bash',
  input: { command: 'echo hello' },
  content: [{ type: 'text', text: 'original tool output' }],
  details: {},
  isError: false
}

export function patchText(attempt = 1): string {
  return `original tool output\n=== COLLABORATION CONTEXT PATCH ===\ndelivery delivery-1 attempt=${attempt}\n/findings finding high producer=producer\nschema v31 is risky`
}

export function providerRequestWithPatch(attempt = 1) {
  return {
    type: 'before_provider_request',
    payload: { messages: [{ role: 'tool', content: [{ type: 'text', text: patchText(attempt) }] }] }
  }
}

export const ASSISTANT_MESSAGE_START = {
  type: 'message_start',
  message: { role: 'assistant', content: [] }
}

export function preparedResult(attempt = 1, deliveryId = 'delivery-1') {
  return {
    active: true,
    entries: [
      {
        deliveryId,
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

export function settledAck(active = true) {
  return { active, ackedDeliveryIds: active ? ['delivery-1'] : [], ignoredDeliveryIds: [] }
}
