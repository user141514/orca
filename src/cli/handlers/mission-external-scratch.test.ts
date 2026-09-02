import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HandlerContext } from '../dispatch'
import type { RuntimeClient } from '../runtime-client'
import { MISSION_HANDLERS } from './mission'

type MissionPlanResult = {
  mission: string
  agent: string
  plan: { mode: 'single-agent' }
}

function response<T>(result: T) {
  return { id: 'test', ok: true as const, result, _meta: { runtimeId: 'runtime-test' } }
}

function readyStatusResponse() {
  return response({
    target: { kind: 'local' },
    app: { running: true, desktopWindowStatus: 'available' },
    runtime: { state: 'ready', reachable: true, runtimeId: 'runtime-test' },
    graph: { state: 'ready' }
  })
}

function makeContext(client: RuntimeClient, text: string): HandlerContext {
  return {
    client,
    flags: new Map([['text', text]]),
    cwd: '/repo',
    json: false
  }
}

describe('external mission scratch workspace', () => {
  afterEach(() => {
    delete process.env.ORCA_MISSION_SCRATCH_ROOT
    vi.restoreAllMocks()
  })

  it('creates a scratch folder workspace and coordinator for an external mission shell', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'orca-mission-scratch-'))
    process.env.ORCA_MISSION_SCRATCH_ROOT = scratchRoot
    const ensureOrca = vi.fn().mockResolvedValue(readyStatusResponse())
    let createdFolderPath: string | undefined
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'worktree.list') {
        return response({ worktrees: [], count: 0 })
      }
      if (method === 'projectGroup.list') {
        return response({ groups: [] })
      }
      if (method === 'projectGroup.create') {
        return response({
          group: { id: 'group-scratch', name: 'Mission Scratch', parentPath: scratchRoot }
        })
      }
      if (method === 'folderWorkspace.create') {
        createdFolderPath = params?.folderPath as string | undefined
        return response({
          folderWorkspace: {
            id: 'fw-scratch',
            projectGroupId: 'group-scratch',
            folderPath: createdFolderPath
          }
        })
      }
      if (method === 'terminal.create') {
        return response({ terminal: { handle: 'term-scratch-coord' } })
      }
      if (method === 'mission.plan') {
        return response<MissionPlanResult>({
          mission: 'external scratch mission',
          agent: 'pi',
          plan: { mode: 'single-agent' }
        })
      }
      if (method === 'orchestration.runCreate') {
        throw new Error('run_probe')
      }
      if (method === 'terminal.close') {
        return response({ close: { closed: true } })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, ensureOrca, isRemote: false } as unknown as RuntimeClient

    try {
      await expect(
        MISSION_HANDLERS['mission start'](makeContext(client, 'external scratch mission'))
      ).rejects.toThrow('run_probe')

      expect(ensureOrca).toHaveBeenCalledWith(60_000)
      expect(createdFolderPath).toContain(scratchRoot)
      expect(createdFolderPath).toContain('runs')
      expect(call).toHaveBeenCalledWith(
        'terminal.create',
        expect.objectContaining({
          worktree: 'folder:fw-scratch',
          title: 'Mission coordinator',
          focus: false
        })
      )
      expect(call).toHaveBeenCalledWith('mission.plan', {
        text: 'external scratch mission',
        worktree: 'folder:fw-scratch',
        agent: undefined
      })
      expect(call).toHaveBeenCalledWith('orchestration.runCreate', {
        objective: 'external scratch mission',
        from: 'term-scratch-coord'
      })
      expect(call).toHaveBeenCalledWith('terminal.close', { terminal: 'term-scratch-coord' })
    } finally {
      await rm(scratchRoot, { recursive: true, force: true })
    }
  })

  it('serializes scratch group creation for concurrent external mission shells', async () => {
    const scratchRoot = await mkdtemp(join(tmpdir(), 'orca-mission-scratch-race-'))
    process.env.ORCA_MISSION_SCRATCH_ROOT = scratchRoot
    const ensureOrca = vi.fn().mockResolvedValue(readyStatusResponse())
    let group: { id: string; name: string; parentPath: string } | undefined
    let groupCreates = 0
    let workspaceCreates = 0
    let terminalCreates = 0
    const call = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'worktree.list') {
        return response({ worktrees: [], count: 0 })
      }
      if (method === 'projectGroup.list') {
        const snapshot = group
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
        return response({ groups: snapshot ? [snapshot] : [] })
      }
      if (method === 'projectGroup.create') {
        groupCreates += 1
        group = { id: `group-${groupCreates}`, name: 'Mission Scratch', parentPath: scratchRoot }
        return response({ group })
      }
      if (method === 'folderWorkspace.create') {
        workspaceCreates += 1
        return response({
          folderWorkspace: {
            id: `fw-${workspaceCreates}`,
            projectGroupId: params?.projectGroupId,
            folderPath: params?.folderPath
          }
        })
      }
      if (method === 'terminal.create') {
        terminalCreates += 1
        return response({ terminal: { handle: `term-${terminalCreates}` } })
      }
      if (method === 'mission.plan') {
        throw new Error('planner_probe')
      }
      if (method === 'terminal.close') {
        return response({ close: { closed: true } })
      }
      throw new Error(`unexpected method: ${method}`)
    })
    const client = { call, ensureOrca, isRemote: false } as unknown as RuntimeClient

    try {
      const results = await Promise.allSettled([
        MISSION_HANDLERS['mission start'](makeContext(client, 'mission A')),
        MISSION_HANDLERS['mission start'](makeContext(client, 'mission B'))
      ])

      expect(results).toHaveLength(2)
      expect(results.every((result) => result.status === 'rejected')).toBe(true)
      expect(groupCreates).toBe(1)
      expect(workspaceCreates).toBe(2)
      expect(terminalCreates).toBe(2)
    } finally {
      await rm(scratchRoot, { recursive: true, force: true })
    }
  })
})
