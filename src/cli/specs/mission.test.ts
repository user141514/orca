import { describe, expect, it } from 'vitest'
import { MISSION_COMMAND_SPECS } from './mission'

describe('mission command specs', () => {
  it('exposes the orca-sub mission start surface without a shared retry request id', () => {
    const spec = MISSION_COMMAND_SPECS.find(
      (candidate) => candidate.path.join(' ') === 'mission start'
    )
    expect(spec).toBeDefined()
    expect(spec?.usage).toContain('mission start --text <mission>')
    expect(spec?.allowedFlags).toEqual(
      expect.arrayContaining(['text', 'agent', 'worktree', 'from', 'json'])
    )
    expect(spec?.allowedFlags).not.toContain('retry-request')
  })

  it('exposes detached mission show, answer, and stop controls', () => {
    const byPath = new Map(
      MISSION_COMMAND_SPECS.map((spec) => [spec.path.join(' '), spec])
    )

    expect(byPath.get('mission show')?.allowedFlags).toEqual(
      expect.arrayContaining(['run', 'json'])
    )
    expect(byPath.get('mission answer')?.allowedFlags).toEqual(
      expect.arrayContaining(['run', 'question', 'body', 'request-id', 'json'])
    )
    expect(byPath.get('mission stop')?.allowedFlags).toEqual(
      expect.arrayContaining(['run', 'stop-token', 'reason', 'request-id', 'json'])
    )
  })
})
