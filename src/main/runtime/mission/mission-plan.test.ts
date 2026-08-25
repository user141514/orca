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

  it('accepts explicit collaboration topics and admission policy', () => {
    const plan = parseMissionPlan(
      JSON.stringify({
        mode: 'orchestration',
        objective: 'Share findings while both workers run',
        maxConcurrency: 2,
        tasks: [
          {
            key: 'producer',
            spec: 'Investigate and publish findings.',
            deps: [],
            publishesTo: ['/findings'],
            requiredPublishesTo: ['/findings']
          },
          {
            key: 'consumer',
            spec: 'Consume findings at stage checkpoints.',
            deps: [],
            subscribesTo: ['/findings'],
            admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
          }
        ]
      })
    )
    expect(plan).toMatchObject({
      mode: 'orchestration',
      tasks: [
        {
          key: 'producer',
          publishesTo: ['/findings'],
          requiredPublishesTo: ['/findings']
        },
        {
          key: 'consumer',
          subscribesTo: ['/findings'],
          admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
        }
      ]
    })
  })

  it('rejects required publish topics that are not allowed by publishesTo', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'invalid publish obligation',
          maxConcurrency: 2,
          tasks: [
            {
              key: 'producer',
              spec: 'Produce.',
              publishesTo: ['/findings'],
              requiredPublishesTo: ['/decision']
            },
            { key: 'other', spec: 'Other.' }
          ]
        })
      )
    ).toThrow(
      'Mission plan task producer requiredPublishesTo must be a subset of publishesTo: /decision'
    )
  })

  it('rejects a subscribed topic with no publisher in the mission', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'orphan subscription',
          maxConcurrency: 2,
          tasks: [
            { key: 'producer', spec: 'Produce.', publishesTo: ['/finding'] },
            {
              key: 'consumer',
              spec: 'Consume.',
              subscribesTo: ['/findings'],
              admission: { acceptedTypes: ['finding'], minPriority: 'normal' }
            }
          ]
        })
      )
    ).toThrow('Mission plan task consumer subscribesTo topic has no publisher: /findings')
  })

  it('rejects a subscribed task without admission policy', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'invalid collaboration plan',
          maxConcurrency: 2,
          tasks: [
            { key: 'producer', spec: 'Produce.', publishesTo: ['/findings'] },
            { key: 'consumer', spec: 'Consume.', subscribesTo: ['/findings'] }
          ]
        })
      )
    ).toThrow('Mission plan task consumer subscribesTo requires admission')
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

  it('rejects a self dependency cycle', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'self cycle',
          maxConcurrency: 1,
          tasks: [
            { key: 'self', spec: 'self', deps: ['self'] },
            { key: 'other', spec: 'other', deps: [] }
          ]
        })
      )
    ).toThrow('Mission plan task dependency cycle detected: self')
  })

  it('rejects a multi-task dependency cycle', () => {
    expect(() =>
      parseMissionPlan(
        JSON.stringify({
          mode: 'orchestration',
          objective: 'two task cycle',
          maxConcurrency: 2,
          tasks: [
            { key: 'a', spec: 'a', deps: ['b'] },
            { key: 'b', spec: 'b', deps: ['a'] }
          ]
        })
      )
    ).toThrow('Mission plan task dependency cycle detected: a')
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
    expect(prompt).toContain('publishesTo')
    expect(prompt).toContain('subscribesTo')
    expect(prompt).toContain('requiredPublishesTo')
    expect(prompt).toContain('acceptedTypes')
    expect(prompt).toContain('Analyze both layers in parallel and integrate them.')
  })
})
