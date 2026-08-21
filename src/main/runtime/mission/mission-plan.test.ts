import { describe, expect, it } from 'vitest'
import { buildMissionPlanningPrompt, parseMissionPlan } from './mission-plan'

describe('Mission planning contract', () => {
  it('accepts a single-agent decision', () => {
    expect(parseMissionPlan('{"mode":"single-agent"}')).toEqual({ mode: 'single-agent' })
  })

  it('accepts a dependency-aware orchestration plan', () => {
    expect(
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'Inspect two layers and integrate the findings',
          maxConcurrency: 2,
          tasks: [
            { key: 'mission', spec: 'Inspect Mission entry', deps: [] },
            { key: 'control', spec: 'Inspect orchestration control plane', deps: [] },
            {
              key: 'integrate',
              spec: 'Integrate both findings',
              deps: ['mission', 'control']
            }
          ]
        })
      )
    ).toEqual({
      mode: 'orchestration',
      objective: 'Inspect two layers and integrate the findings',
      maxConcurrency: 2,
      tasks: [
        { key: 'mission', spec: 'Inspect Mission entry', deps: [] },
        { key: 'control', spec: 'Inspect orchestration control plane', deps: [] },
        { key: 'integrate', spec: 'Integrate both findings', deps: ['mission', 'control'] }
      ]
    })
  })

  it('rejects malformed planner output', () => {
    expect(() => parseMissionPlan('not-json')).toThrow('Mission planner returned invalid JSON.')
  })

  it('rejects duplicate task keys', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'duplicate',
          maxConcurrency: 2,
          tasks: [
            { key: 'same', spec: 'first' },
            { key: 'same', spec: 'second' }
          ]
        })
      )
    ).toThrow('Duplicate Mission plan task key: same')
  })

  it('rejects unknown dependency keys', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'unknown dependency',
          maxConcurrency: 2,
          tasks: [
            { key: 'first', spec: 'first' },
            { key: 'join', spec: 'join', deps: ['missing'] }
          ]
        })
      )
    ).toThrow('Unknown Mission plan dependency: missing')
  })

  it('instructs the planner to output only logical intent, not execution authority', () => {
    const prompt = buildMissionPlanningPrompt('Analyze both layers in parallel and integrate them.')
    expect(prompt).toContain('single-agent')
    expect(prompt).toContain('orchestration')
    expect(prompt).toContain('JSON only')
    expect(prompt).toContain('Do not choose execution backends')
    expect(prompt).toContain('worker_done')
    expect(prompt).toContain('Analyze both layers in parallel and integrate them.')
  })
})
