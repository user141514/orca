import { describe, expect, it } from 'vitest'
import { buildCollaborationStepInput } from './collaboration-context'

describe('buildCollaborationStepInput', () => {
  it('adds predecessor results without changing steps that have no context', () => {
    expect(buildCollaborationStepInput('Work independently.', [])).toBe('Work independently.')

    expect(
      buildCollaborationStepInput('Synthesize the findings.', [
        { stepKey: 'research', result: 'Finding A' },
        { stepKey: 'review', result: 'Finding B' }
      ])
    ).toBe(
      [
        '=== PREDECESSOR RESULTS ===',
        '[research]',
        'Finding A',
        '',
        '[review]',
        'Finding B',
        '',
        '=== CURRENT STEP ===',
        'Synthesize the findings.'
      ].join('\n')
    )
  })
})
