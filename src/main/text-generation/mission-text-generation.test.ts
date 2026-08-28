import { spawn } from 'node:child_process'
import type * as ChildProcess from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  discoverCommitMessageModelsLocal,
  generateTextFromPrompt
} from './commit-message-text-generation'
import { createMockDiscoveryChild } from './commit-message-text-generation-test-harness'

const { terminateWindowsProcessTreeMock } = vi.hoisted(() => ({
  terminateWindowsProcessTreeMock: vi.fn(async () => {})
}))

vi.mock('../windows-process-tree-kill', () => ({
  terminateWindowsProcessTree: terminateWindowsProcessTreeMock
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn)
  }
})

const spawnMock = vi.mocked(spawn)

beforeEach(() => {
  spawnMock.mockReset()
  terminateWindowsProcessTreeMock.mockClear()
  terminateWindowsProcessTreeMock.mockResolvedValue(undefined)
})

function createGenerationChild(pid: number) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number
    kill: ReturnType<typeof vi.fn>
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { end: ReturnType<typeof vi.fn> }
  }
  child.pid = pid
  child.kill = vi.fn()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stdin = { end: vi.fn() }
  return child
}

describe('generateTextFromPrompt', () => {
  it('reuses the non-interactive agent runner and returns raw mission planner output', async () => {
    const execute = vi.fn().mockResolvedValue({
      stdout: '{"mode":"single-agent"}\n',
      stderr: '',
      exitCode: 0,
      timedOut: false
    })

    const result = await generateTextFromPrompt(
      'Return JSON only.',
      {
        agentId: 'pi',
        model: 'github-copilot/gpt-5.4-mini'
      },
      {
        kind: 'remote',
        cwd: '/repo',
        execute,
        missingBinaryLocation: 'remote host'
      },
      'mission-plan',
      { useAgentDefaultModel: true }
    )

    expect(result).toEqual({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'Pi'
    })
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        binary: 'pi',
        label: 'Pi',
        args: expect.not.arrayContaining(['--model', 'github-copilot/gpt-5.4-mini'])
      }),
      '/repo',
      expect.any(Number),
      'mission-plan'
    )
  })

  it('returns canceled without spawning when its signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      generateTextFromPrompt(
        'Return JSON only.',
        { agentId: 'custom', model: '', customAgentCommand: 'agent' },
        { kind: 'local', cwd: '/repo' },
        'mission-plan',
        { signal: controller.signal }
      )
    ).resolves.toEqual({ success: false, error: 'Generation canceled.', canceled: true })

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('aborts only the invocation that owns the signal when same-home planners overlap', async () => {
    const firstChild = createGenerationChild(101)
    const secondChild = createGenerationChild(102)
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(secondChild as never)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const params = { agentId: 'custom' as const, model: '', customAgentCommand: 'agent' }
    const target = { kind: 'local' as const, cwd: '/repo', env: { CODEX_HOME: '/same-home' } }

    const first = generateTextFromPrompt('Return JSON only.', params, target, 'mission-plan', {
      signal: firstController.signal
    })
    const second = generateTextFromPrompt('Return JSON only.', params, target, 'mission-plan', {
      signal: secondController.signal
    })
    firstController.abort()

    expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')
    expect(secondChild.kill).not.toHaveBeenCalled()
    firstChild.emit('close', null)
    secondChild.stdout.emit('data', Buffer.from('{"mode":"single-agent"}\n'))
    secondChild.emit('close', 0)

    await expect(first).resolves.toEqual({ success: false, error: 'Generation canceled.', canceled: true })
    await expect(second).resolves.toEqual({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'agent'
    })
  })

  it('removes an aborted Codex planner from the home-lock queue before it can spawn', async () => {
    const firstChild = createMockDiscoveryChild()
    const laterChild = createMockDiscoveryChild()
    spawnMock.mockReturnValueOnce(firstChild as never).mockReturnValueOnce(laterChild as never)
    const env = { CODEX_HOME: '/mission-planner-home' }
    const blocker = discoverCommitMessageModelsLocal('codex', env)
    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1))
    const controller = new AbortController()

    const queued = generateTextFromPrompt(
      'Return JSON only.',
      { agentId: 'codex', model: 'gpt-5.5' },
      { kind: 'local', cwd: '/repo', env },
      'mission-plan',
      { signal: controller.signal }
    )
    controller.abort()

    await expect(queued).resolves.toEqual({ success: false, error: 'Generation canceled.', canceled: true })
    firstChild.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5' }] }))
    )
    firstChild.emit('close', 0)
    await expect(blocker).resolves.toMatchObject({ success: true })
    await Promise.resolve()

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('waits for the aborted planner child to close before resolving on POSIX', async () => {
    const child = createGenerationChild(103)
    spawnMock.mockReturnValue(child as never)
    const controller = new AbortController()
    const pending = generateTextFromPrompt(
      'Return JSON only.',
      { agentId: 'custom', model: '', customAgentCommand: 'agent' },
      { kind: 'local', cwd: '/repo' },
      'mission-plan',
      { signal: controller.signal }
    )

    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending')

    child.emit('close', null)
    await expect(pending).resolves.toEqual({ success: false, error: 'Generation canceled.', canceled: true })
  })

  it('waits for Windows process-tree termination before resolving an aborted planner', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    let finishTermination!: () => void
    terminateWindowsProcessTreeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishTermination = resolve
      })
    )
    const child = createGenerationChild(104)
    spawnMock.mockReturnValue(child as never)
    const controller = new AbortController()

    try {
      const pending = generateTextFromPrompt(
        'Return JSON only.',
        { agentId: 'custom', model: '', customAgentCommand: 'agent' },
        { kind: 'local', cwd: 'C:\\repo' },
        'mission-plan',
        { signal: controller.signal }
      )
      controller.abort()
      expect(terminateWindowsProcessTreeMock).toHaveBeenCalledWith(104)
      await expect(Promise.race([pending, Promise.resolve('pending')])).resolves.toBe('pending')

      finishTermination()
      await expect(pending).resolves.toEqual({
        success: false,
        error: 'Generation canceled.',
        canceled: true
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })
})
