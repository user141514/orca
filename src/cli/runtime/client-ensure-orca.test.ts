import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CliStatusResult } from '../../shared/runtime-types'
import { RuntimeClient } from './client'
import { launchOrcaApp } from './launch'
import {
  reconcileWindowsOrcaRuntimes,
  withOrcaHostStartLock
} from './windows-orca-runtime-ownership'

vi.mock('./launch', () => ({ launchOrcaApp: vi.fn() }))
vi.mock('./windows-orca-runtime-ownership', () => ({
  reconcileWindowsOrcaRuntimes: vi.fn(),
  withOrcaHostStartLock: vi.fn(async (run: () => Promise<unknown>) => await run())
}))

function status(overrides: Partial<CliStatusResult> = {}): CliStatusResult {
  return {
    target: { kind: 'local' },
    app: { running: true, pid: 4321, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', reachable: true, runtimeId: 'runtime-ready' },
    graph: { state: 'ready' },
    ...overrides
  }
}

describe('RuntimeClient.ensureOrca', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.mocked(launchOrcaApp).mockReset()
    vi.mocked(reconcileWindowsOrcaRuntimes).mockReset()
    vi.mocked(withOrcaHostStartLock).mockClear()
  })

  it('reconciles extra host owners under the host lock when the exact target is already ready', async () => {
    const client = new RuntimeClient('C:\\profile')
    vi.spyOn(client, 'getCliStatus').mockResolvedValue({
      id: 'status-ready',
      ok: true,
      result: status(),
      _meta: { runtimeId: 'runtime-ready' }
    })

    const result = await client.ensureOrca(100)

    expect(result.result.runtime.state).toBe('ready')
    expect(withOrcaHostStartLock).toHaveBeenCalledTimes(1)
    expect(reconcileWindowsOrcaRuntimes).toHaveBeenCalledWith({ preservePid: 4321 })
    expect(launchOrcaApp).not.toHaveBeenCalled()
  })

  it('replaces existing host owners and launches only after entering the host lock when target is absent', async () => {
    const client = new RuntimeClient('C:\\profile')
    vi.spyOn(client, 'getCliStatus')
      .mockResolvedValueOnce({
        id: 'status-zero',
        ok: true,
        result: status({
          app: { running: false, pid: null },
          runtime: { state: 'not_running', reachable: false, runtimeId: null },
          graph: { state: 'not_running' }
        }),
        _meta: { runtimeId: 'none' }
      })
      .mockResolvedValue({
        id: 'status-ready',
        ok: true,
        result: status(),
        _meta: { runtimeId: 'runtime-ready' }
      })

    await client.ensureOrca(100)

    expect(withOrcaHostStartLock).toHaveBeenCalledTimes(1)
    expect(reconcileWindowsOrcaRuntimes).toHaveBeenCalledWith()
    expect(vi.mocked(reconcileWindowsOrcaRuntimes).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(launchOrcaApp).mock.invocationCallOrder[0]!
    )
  })
})
