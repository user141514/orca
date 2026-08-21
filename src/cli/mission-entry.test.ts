import { describe, expect, it } from 'vitest'
import { normalizeRootMissionArgs } from './mission-entry'

describe('normalizeRootMissionArgs', () => {
  it('turns one quoted natural-language argument into the internal mission command', () => {
    expect(normalizeRootMissionArgs(['help me refactor login safely'])).toEqual([
      'mission',
      'start',
      '--text',
      'help me refactor login safely'
    ])
  })

  it('accepts compact non-ASCII mission text', () => {
    expect(normalizeRootMissionArgs(['完成登录模块重构'])).toEqual([
      'mission',
      'start',
      '--text',
      '完成登录模块重构'
    ])
  })

  it('preserves root mission options such as an explicit agent', () => {
    expect(normalizeRootMissionArgs(['mission context', '--agent', 'claude'])).toEqual([
      'mission',
      'start',
      '--text',
      'mission context',
      '--agent',
      'claude'
    ])
  })

  it('does not reinterpret a likely mistyped command as a mission', () => {
    expect(normalizeRootMissionArgs(['worktreee'])).toEqual(['worktreee'])
  })

  it('leaves explicit Orca commands unchanged', () => {
    expect(normalizeRootMissionArgs(['orchestration', 'run-list'])).toEqual([
      'orchestration',
      'run-list'
    ])
  })
})
