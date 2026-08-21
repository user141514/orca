import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

const databases: { db: OrchestrationDb; dir: string }[] = []

afterEach(() => {
  for (const { db, dir } of databases.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('Run coordination consumer lease', () => {
  it('fences a stale consumer at the same transaction that accepts a Dispatch', () => {
    const db = createDatabase()
    const run = db.createRun({ objective: 'consumer lease prototype' })
    const task = db.createTask({ spec: 'claim me once', runId: run.id })
    const staleLease = db.acquireRunConsumer({ runId: run.id, consumerId: 'controller-a' })
    const currentLease = db.acquireRunConsumer({ runId: run.id, consumerId: 'controller-b' })

    let staleError: unknown
    try {
      db.createStartingWorkerDispatch({
        taskId: task.id,
        startOptions: {},
        coordinationLease: staleLease
      })
    } catch (error) {
      staleError = error
    }
    expect(staleError).toMatchObject({ code: 'consumer_fenced' })

    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      coordinationLease: currentLease
    })

    expect(db.getTask(task.id)?.status).toBe('dispatched')
    expect(started.dispatch).toMatchObject({ run_id: run.id, task_id: task.id, status: 'pending' })
  })

  it('does not revoke an already accepted Dispatch when another consumer takes over', () => {
    const db = createDatabase()
    const run = db.createRun({ objective: 'accepted dispatch survives takeover' })
    const task = db.createTask({ spec: 'already accepted work', runId: run.id })
    const firstLease = db.acquireRunConsumer({ runId: run.id, consumerId: 'controller-a' })
    const started = db.createStartingWorkerDispatch({
      taskId: task.id,
      startOptions: {},
      coordinationLease: firstLease
    })

    const secondLease = db.acquireRunConsumer({ runId: run.id, consumerId: 'controller-b' })
    const ready = db.markWorkerDispatchReady(started.dispatch.id)

    expect(secondLease.generation).toBe(firstLease.generation + 1)
    expect(ready).toMatchObject({ state: 'ready', stage: 'input_accepted' })
    expect(db.getDispatchContextById(started.dispatch.id)?.status).toBe('dispatched')
  })
})

function createDatabase(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-run-consumer-lease-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  databases.push({ db, dir })
  return db
}
