import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeClient } from '../runtime-client'
import { MISSION_HANDLERS } from './mission'

const log = vi.spyOn(console, 'log').mockImplementation(() => {})

afterEach(() => {
  log.mockClear()
})

describe('mission CLI handler', () => {
  it('targets the Orca-managed worktree enclosing cwd and starts the mission', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          worktrees: [{ id: 'repo::worktree', path: '/tmp/repo', name: 'repo' }]
        }
      })
      .mockResolvedValueOnce({
        result: {
          mission: 'refactor login safely',
          mode: 'single-agent',
          agent: 'codex',
          terminal: { handle: 'term_mission' }
        }
      })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await MISSION_HANDLERS['mission start']({
      flags: new Map([
        ['text', 'refactor login safely'],
        ['agent', 'claude']
      ]),
      client,
      cwd: '/tmp/repo/src',
      json: true
    })

    expect(call).toHaveBeenNthCalledWith(1, 'worktree.list', { limit: 10_000 })
    expect(call).toHaveBeenNthCalledWith(2, 'mission.start', {
      text: 'refactor login safely',
      worktree: 'id:repo::worktree',
      agent: 'claude'
    })
  })

  it('prints the Run when the mission is routed to orchestration', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        result: {
          worktrees: [{ id: 'repo::worktree', path: '/tmp/repo', name: 'repo' }]
        }
      })
      .mockResolvedValueOnce({
        result: {
          mission: 'parallel review',
          mode: 'orchestration',
          agent: 'pi',
          runId: 'run_123',
          state: 'running'
        }
      })
    const client = { call, isRemote: false } as unknown as RuntimeClient

    await MISSION_HANDLERS['mission start']({
      flags: new Map([['text', 'parallel review']]),
      client,
      cwd: '/tmp/repo',
      json: false
    })

    expect(log.mock.calls.flat().join('\n')).toContain('Mission run run_123 started with pi')
  })
})
