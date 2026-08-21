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
})
