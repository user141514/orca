import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('Run control policy', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  it.each([0, -1, 1.5])('rejects invalid maxConcurrency %s before persistence', (value) => {
    db = new OrchestrationDb(':memory:')
    const run = db.createRun({ objective: 'validate policy' })
    const lease = db.acquireRunConsumer({ runId: run.id, consumerId: 'test-consumer' })
    db.setRunControlPolicy(lease, { maxConcurrency: 2 })

    expect(() => db!.setRunControlPolicy(lease, { maxConcurrency: value })).toThrow(
      'Run maxConcurrency must be a positive integer.'
    )
    expect(db.getRunControlPolicy(run.id)).toEqual({ maxConcurrency: 2 })
  })
})
