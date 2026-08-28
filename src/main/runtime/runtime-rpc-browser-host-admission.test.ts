import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import type * as RunProcess from '../../shared/child-process/run-process'
import { spawnProcess } from '../../shared/child-process/run-process'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { defineStreamingMethod, type RpcRequest } from './rpc/core'
import { MISSION_METHODS } from './rpc/methods/mission'
import { classifyRuntimeLongPoll, OrcaRuntimeRpcServer } from './runtime-rpc'
import { withCurrentOrchestrationContract } from './runtime-rpc-test-harness'

const { spawnProcessMock } = vi.hoisted(() => ({ spawnProcessMock: vi.fn() }))

vi.mock('../../shared/child-process/run-process', async (importOriginal) => ({
  ...(await importOriginal<typeof RunProcess>()),
  spawnProcess: spawnProcessMock
}))

const mockedSpawnProcess = vi.mocked(spawnProcess)

const request = (method: string, params?: unknown): RpcRequest => ({
  id: method,
  authToken: 'test-token',
  method,
  params
})

describe('runtime RPC browser-host admission', () => {
  it('classifies host attachment for bounded disconnect-aware admission', () => {
    expect(classifyRuntimeLongPoll(request('browser.clientHost.attach'))).toBe('browser-host')
    expect(classifyRuntimeLongPoll(request('mission.plan'))).toBe('mission-plan')
    expect(classifyRuntimeLongPoll(request('terminal.wait'))).toBe('wait')
    expect(classifyRuntimeLongPoll(request('orchestration.ask'))).toBe('ask')
    expect(classifyRuntimeLongPoll(request('orchestration.workerStart'))).toBe('wait')
    expect(classifyRuntimeLongPoll(request('orchestration.check', { wait: true }))).toBe('wait')
    expect(classifyRuntimeLongPoll(request('status.get'))).toBeNull()
  })

  it('caps mission planning independently while accounting for the total long-poll cap', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mission-plan-admission-'))
    const blockingMethod = (name: 'mission.plan' | 'terminal.wait') =>
      defineStreamingMethod({
        name,
        params: null,
        handler: async (_params, { signal }) =>
          await new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true })
          )
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 3,
      methods: [blockingMethod('mission.plan'), blockingMethod('terminal.wait')]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'connection-a'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const socket = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, method: 'mission.plan' | 'terminal.wait') =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method, deviceToken: device.token }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const plans = [dispatch('plan-a', 'mission.plan'), dispatch('plan-b', 'mission.plan')]
      await vi.waitFor(() => expect(server['activeMissionPlanLongPolls']).toBe(2))
      expect(server['activeLongPolls']).toBe(2)

      await dispatch('plan-overflow', 'mission.plan')
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'plan-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'mission.plan capacity reached; retry with backoff'
          })
        })
      )
      expect(server['activeLongPolls']).toBe(2)

      const wait = dispatch('wait-a', 'terminal.wait')
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(3))
      await dispatch('wait-overflow', 'terminal.wait')
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'wait-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'long-poll capacity reached; retry with backoff'
          })
        })
      )

      socket.readyState = 3
      socket.emit('close')
      await Promise.all([...plans, wait])
      expect(server['activeLongPolls']).toBe(0)
      expect(server['activeMissionPlanLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('holds mission-plan admission until a disconnected planner child terminates', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mission-plan-disconnect-'))
    const firstChild = createPlannerChild(101)
    const secondChild = createPlannerChild(102)
    const retryChild = createPlannerChild(103)
    const spawnedChildren = [firstChild, secondChild, retryChild]
    mockedSpawnProcess.mockReset()
    mockedSpawnProcess.mockImplementation(() => spawnedChildren.shift() as never)

    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'pi',
      disabledTuiAgents: [],
      agentCmdOverrides: {}
    } as unknown as ReturnType<OrcaRuntimeService['getClientSettings']>)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({} as never)
    const server = new OrcaRuntimeRpcServer({
      runtime,
      userDataPath,
      longPollCap: 3,
      methods: MISSION_METHODS
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    const firstSocket = new FakeWebSocket()
    const secondSocket = new FakeWebSocket()
    const retrySocket = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, socket: FakeWebSocket) =>
      server['handleWebSocketMessage'](
        JSON.stringify({
          id,
          method: 'mission.plan',
          deviceToken: device.token,
          params: { text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' }
        }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const first = dispatch('plan-first', firstSocket)
      const second = dispatch('plan-second', secondSocket)
      await vi.waitFor(() => expect(mockedSpawnProcess).toHaveBeenCalledTimes(2))
      expect(server['activeMissionPlanLongPolls']).toBe(2)

      firstSocket.readyState = 3
      firstSocket.emit('close')
      expect(firstChild.kill).toHaveBeenCalledWith('SIGKILL')

      await dispatch('plan-before-termination', retrySocket)
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'plan-before-termination',
          ok: false,
          error: expect.objectContaining({
            message: 'mission.plan capacity reached; retry with backoff'
          })
        })
      )
      expect(server['activeMissionPlanLongPolls']).toBe(2)

      firstChild.emit('close', null)
      await first
      await vi.waitFor(() => expect(server['activeMissionPlanLongPolls']).toBe(1))

      const retry = dispatch('plan-after-termination', retrySocket)
      await vi.waitFor(() => expect(mockedSpawnProcess).toHaveBeenCalledTimes(3))
      expect(server['activeMissionPlanLongPolls']).toBe(2)

      secondSocket.readyState = 3
      retrySocket.readyState = 3
      secondSocket.emit('close')
      retrySocket.emit('close')
      expect(secondChild.kill).toHaveBeenCalledWith('SIGKILL')
      expect(retryChild.kill).toHaveBeenCalledWith('SIGKILL')
      secondChild.emit('close', null)
      retryChild.emit('close', null)
      await Promise.all([second, retry])
      expect(server['activeMissionPlanLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('reserves wait capacity and releases host admission on socket close', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-admission-'))
    const aborted = vi.fn()
    const blockingMethod = (name: 'browser.clientHost.attach' | 'terminal.wait') =>
      defineStreamingMethod({
        name,
        params: null,
        handler: async (_params, { signal }) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener(
              'abort',
              () => {
                aborted(name)
                resolve()
              },
              { once: true }
            )
          })
        }
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 4,
      methods: [blockingMethod('browser.clientHost.attach'), blockingMethod('terminal.wait')]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry'].addDevice('runtime-test', 'runtime')
    server['mobileSocketWiring'] = {
      getConnectionId: () => 'connection-a'
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const socket = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, method: string) =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method, deviceToken: device.token }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const host = dispatch('host-a', 'browser.clientHost.attach')
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(1))
      await dispatch('host-overflow', 'browser.clientHost.attach')
      expect(replies).toContainEqual(
        expect.objectContaining({
          id: 'host-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'browser-host capacity reached; retry with backoff'
          })
        })
      )

      const wait = dispatch('wait-a', 'terminal.wait')
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(2))

      socket.readyState = 3
      socket.emit('close')
      await Promise.all([host, wait])
      expect(server['activeLongPolls']).toBe(0)
      expect(server['activeBrowserHostLongPolls']).toBe(0)
      expect(aborted).toHaveBeenCalledWith('browser.clientHost.attach')
      expect(aborted).toHaveBeenCalledWith('terminal.wait')
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('reserves browser-host capacity for a second paired device', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-fairness-'))
    const blockingHost = defineStreamingMethod({
      name: 'browser.clientHost.attach',
      params: null,
      handler: async (_params, { signal }) =>
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
    })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 16,
      methods: [blockingHost]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const deviceA = server['deviceRegistry'].addDevice('runtime-a', 'runtime')
    const deviceB = server['deviceRegistry'].addDevice('runtime-b', 'runtime')
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const socketAReplacement = new FakeWebSocket()
    const connectionIds = new Map([
      [socketA, 'connection-a'],
      [socketB, 'connection-b'],
      [socketAReplacement, 'connection-a-replacement']
    ])
    server['mobileSocketWiring'] = {
      getConnectionId: (socket) => connectionIds.get(socket as unknown as FakeWebSocket)
    } as unknown as NonNullable<(typeof server)['mobileSocketWiring']>
    const repliesA: Record<string, unknown>[] = []
    const repliesB: Record<string, unknown>[] = []
    const dispatch = (
      id: string,
      deviceToken: string,
      socket: FakeWebSocket,
      replies: Record<string, unknown>[]
    ) =>
      server['handleWebSocketMessage'](
        JSON.stringify({ id, method: 'browser.clientHost.attach', deviceToken }),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const deviceAHosts = Array.from({ length: 4 }, (_, index) =>
        dispatch(`host-a-${index}`, deviceA.token, socketA, repliesA)
      )
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(4))

      await dispatch('host-a-overflow', deviceA.token, socketA, repliesA)
      expect(repliesA).toContainEqual(
        expect.objectContaining({
          id: 'host-a-overflow',
          ok: false,
          error: expect.objectContaining({
            message: 'browser-host capacity reached; retry with backoff'
          })
        })
      )

      const deviceBHost = dispatch('host-b', deviceB.token, socketB, repliesB)
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(5))
      expect(repliesB).toEqual([])

      socketA.readyState = 3
      socketA.emit('close')
      await Promise.all(deviceAHosts)
      expect(server['activeBrowserHostLongPolls']).toBe(1)

      const replacement = dispatch(
        'host-a-replacement',
        deviceA.token,
        socketAReplacement,
        repliesA
      )
      await vi.waitFor(() => expect(server['activeBrowserHostLongPolls']).toBe(2))

      socketAReplacement.readyState = 3
      socketAReplacement.emit('close')
      socketB.readyState = 3
      socketB.emit('close')
      await Promise.all([replacement, deviceBHost])
      expect(server['activeBrowserHostLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })

  it('keeps a wait slot when asks and browser hosts fill their shared budget', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-browser-host-wait-reserve-'))
    const blockingMethod = (
      name: 'browser.clientHost.attach' | 'orchestration.ask' | 'terminal.wait'
    ) =>
      defineStreamingMethod({
        name,
        params: null,
        handler: async (_params, { signal }) =>
          await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()))
      })
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      longPollCap: 4,
      methods: [
        blockingMethod('browser.clientHost.attach'),
        blockingMethod('orchestration.ask'),
        blockingMethod('terminal.wait')
      ]
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const deviceA = server['deviceRegistry'].addDevice('runtime-a', 'runtime')
    const deviceB = server['deviceRegistry'].addDevice('runtime-b', 'runtime')
    const socketA = new FakeWebSocket()
    const socketB = new FakeWebSocket()
    const replies: Record<string, unknown>[] = []
    const dispatch = (id: string, method: string, token: string, socket: FakeWebSocket) =>
      server['handleWebSocketMessage'](
        JSON.stringify(withCurrentOrchestrationContract({ id, method, deviceToken: token })),
        (reply) => replies.push(JSON.parse(reply) as Record<string, unknown>),
        () => {},
        undefined,
        socket as unknown as WebSocket
      )

    try {
      const active = [
        dispatch('ask-a', 'orchestration.ask', deviceA.token, socketA),
        dispatch('ask-b', 'orchestration.ask', deviceA.token, socketA),
        dispatch('host-a', 'browser.clientHost.attach', deviceA.token, socketA)
      ]
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(3))

      const hostB = dispatch('host-b', 'browser.clientHost.attach', deviceB.token, socketB)
      await vi.waitFor(() =>
        expect(replies).toContainEqual(
          expect.objectContaining({
            id: 'host-b',
            ok: false,
            error: expect.objectContaining({
              message: 'browser-host capacity reached; retry with backoff'
            })
          })
        )
      )

      const wait = dispatch('wait-a', 'terminal.wait', deviceB.token, socketB)
      await vi.waitFor(() => expect(server['activeLongPolls']).toBe(4))

      socketA.readyState = 3
      socketA.emit('close')
      socketB.readyState = 3
      socketB.emit('close')
      await Promise.all([...active, hostB, wait])
      expect(server['activeLongPolls']).toBe(0)
    } finally {
      await server.stop()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1
  readyState = this.OPEN
}

function createPlannerChild(pid: number) {
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
