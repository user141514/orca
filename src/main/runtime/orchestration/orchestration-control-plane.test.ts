import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationControlPlane, OrchestrationScheduler } from './orchestration-control-plane'
import * as controlPlaneModule from './orchestration-control-plane'

const databases: { db: OrchestrationDb; dir: string }[] = []

afterEach(() => {
  for (const { db, dir } of databases.splice(0)) {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('OrchestrationControlPlane', () => {
  it('materializes and advances a DAG without any Agent or Terminal coordinator', () => {
    const db = createDatabase()
    const control = new OrchestrationControlPlane(db, 'controller-main')
    const run = control.createRun('deterministic prototype')
    const first = control.createTask({ spec: 'first branch' })
    const second = control.createTask({ spec: 'second branch' })
    const joinTask = control.createTask({ spec: 'join branches', deps: [first.id, second.id] })

    expect(run.coordinator_handle).toBeNull()
    expect(control.listTasks({ ready: true }).map((task) => task.id)).toEqual([first.id, second.id])
    expect(db.getTask(joinTask.id)?.status).toBe('pending')

    const firstDispatch = control.acceptTask(first.id)
    const secondDispatch = control.acceptTask(second.id)
    db.markWorkerDispatchReady(firstDispatch.dispatch.id)
    db.markWorkerDispatchReady(secondDispatch.dispatch.id)
    db.settleWorkerReport({
      taskId: first.id,
      dispatchId: firstDispatch.dispatch.id,
      outcome: 'succeeded',
      result: 'first done'
    })
    db.settleWorkerReport({
      taskId: second.id,
      dispatchId: secondDispatch.dispatch.id,
      outcome: 'succeeded',
      result: 'second done'
    })

    expect(db.getTask(joinTask.id)?.status).toBe('ready')
  })

  it('materializes a structured plan with logical dependency keys', () => {
    const db = createDatabase()
    const control = new OrchestrationControlPlane(db, 'controller-plan')
    const startPlan = (
      control as unknown as {
        startPlan(plan: {
          objective: string
          maxConcurrency: number
          tasks: { key: string; spec: string; deps?: string[] }[]
        }): { run: { id: string }; tasksByKey: Record<string, { id: string; status: string }> }
      }
    ).startPlan

    const materialized = startPlan.call(control, {
      objective: 'structured plan',
      maxConcurrency: 2,
      tasks: [
        { key: 'a', spec: 'branch A' },
        { key: 'b', spec: 'branch B' },
        { key: 'c', spec: 'join', deps: ['a', 'b'] }
      ]
    })

    expect(materialized.tasksByKey.a?.status).toBe('ready')
    expect(materialized.tasksByKey.b?.status).toBe('ready')
    expect(materialized.tasksByKey.c?.status).toBe('pending')
    const getPolicy = (
      db as unknown as {
        getRunControlPolicy(runId: string): { maxConcurrency: number } | undefined
      }
    ).getRunControlPolicy
    expect(getPolicy.call(db, materialized.run.id)).toEqual({ maxConcurrency: 2 })
    expect(JSON.parse(db.getTask(materialized.tasksByKey.c!.id)!.deps)).toEqual([
      materialized.tasksByKey.a!.id,
      materialized.tasksByKey.b!.id
    ])
  })

  it('schedules ready tasks to the persisted concurrency limit and resumes from DB state', () => {
    const db = createDatabase()
    const planner = new OrchestrationControlPlane(db, 'planner')
    const materialized = planner.startPlan({
      objective: 'scheduler prototype',
      maxConcurrency: 2,
      tasks: [
        { key: 'a', spec: 'branch A' },
        { key: 'b', spec: 'branch B' },
        { key: 'c', spec: 'join', deps: ['a', 'b'] }
      ]
    })
    const Scheduler = (
      controlPlaneModule as unknown as {
        OrchestrationScheduler?: new (
          db: OrchestrationDb,
          consumerId: string
        ) => {
          useRun(runId: string): void
          tick(): {
            state: 'running' | 'completed' | 'blocked'
            started: { taskId: string; dispatchId: string }[]
            active: number
          }
        }
      }
    ).OrchestrationScheduler

    expect(Scheduler).toBeTypeOf('function')
    if (!Scheduler) {
      return
    }

    const firstScheduler = new Scheduler(db, 'scheduler-1')
    firstScheduler.useRun(materialized.run.id)
    const firstTick = firstScheduler.tick()
    expect(firstTick.started.map((entry) => entry.taskId)).toEqual([
      materialized.tasksByKey.a!.id,
      materialized.tasksByKey.b!.id
    ])
    expect(firstTick.active).toBe(2)
    expect(db.getTask(materialized.tasksByKey.c!.id)?.status).toBe('pending')

    for (const started of firstTick.started) {
      db.markWorkerDispatchReady(started.dispatchId)
      db.settleWorkerReport({
        taskId: started.taskId,
        dispatchId: started.dispatchId,
        outcome: 'succeeded',
        result: 'done'
      })
    }

    const restartedScheduler = new Scheduler(db, 'scheduler-2')
    restartedScheduler.useRun(materialized.run.id)
    const secondTick = restartedScheduler.tick()
    expect(secondTick.started.map((entry) => entry.taskId)).toEqual([materialized.tasksByKey.c!.id])
    expect(secondTick.active).toBe(1)

    const joinDispatch = secondTick.started[0]!
    db.markWorkerDispatchReady(joinDispatch.dispatchId)
    db.settleWorkerReport({
      taskId: joinDispatch.taskId,
      dispatchId: joinDispatch.dispatchId,
      outcome: 'succeeded',
      result: 'joined'
    })

    expect(restartedScheduler.tick()).toMatchObject({
      state: 'completed',
      started: [],
      active: 0
    })
  })

  it('runs a structured plan to convergence through an executor interface', async () => {
    const db = createDatabase()
    const Runner = (
      controlPlaneModule as unknown as {
        DeterministicOrchestrationRunner?: new (
          db: OrchestrationDb,
          consumerId: string,
          executor: {
            execute(input: {
              runId: string
              taskId: string
              dispatchId: string
            }): Promise<void> | void
          }
        ) => {
          runPlan(plan: {
            objective: string
            maxConcurrency: number
            tasks: { key: string; spec: string; deps?: string[] }[]
          }): Promise<{ runId: string; state: string }>
        }
      }
    ).DeterministicOrchestrationRunner

    expect(Runner).toBeTypeOf('function')
    if (!Runner) {
      return
    }

    const executionOrder: string[] = []
    const runner = new Runner(db, 'runner-main', {
      execute: ({ taskId, dispatchId }) => {
        executionOrder.push(taskId)
        db.markWorkerDispatchReady(dispatchId)
        db.settleWorkerReport({
          taskId,
          dispatchId,
          outcome: 'succeeded',
          result: 'fake executor completed'
        })
      }
    })

    const result = await runner.runPlan({
      objective: 'automatic deterministic run',
      maxConcurrency: 2,
      tasks: [
        { key: 'a', spec: 'branch A' },
        { key: 'b', spec: 'branch B' },
        { key: 'c', spec: 'join', deps: ['a', 'b'] }
      ]
    })

    expect(result.state).toBe('completed')
    expect(executionOrder).toHaveLength(3)
    const tasks = db.listTasks({ runId: result.runId })
    expect(tasks.every((task) => task.status === 'completed')).toBe(true)
  })

  it('persists execution descriptors so a replacement scheduler can recover routing', () => {
    const db = createDatabase()
    const first = new OrchestrationControlPlane(db, 'controller-a')
    const materialized = first.startPlan({
      objective: 'persistent execution routing',
      maxConcurrency: 1,
      tasks: [
        {
          key: 'worker',
          spec: 'run in the selected workspace',
          execution: {
            backend: 'local-worker',
            config: { worktreeId: 'repo::worker', agent: 'codex' }
          }
        }
      ]
    })

    const replacement = new OrchestrationScheduler(db, 'controller-b')
    replacement.useRun(materialized.run.id)
    const tick = replacement.tick()

    expect(tick.started).toEqual([
      expect.objectContaining({
        taskId: materialized.tasksByKey.worker!.id,
        execution: {
          backend: 'local-worker',
          config: { worktreeId: 'repo::worker', agent: 'codex' }
        }
      })
    ])
    expect(JSON.parse(db.getTask(materialized.tasksByKey.worker!.id)!.execution_spec!)).toEqual({
      backend: 'local-worker',
      config: { worktreeId: 'repo::worker', agent: 'codex' }
    })
  })

  it('fences an old control plane after another consumer takes over the Run', () => {
    const db = createDatabase()
    const first = new OrchestrationControlPlane(db, 'controller-a')
    const run = first.createRun('takeover prototype')
    const second = new OrchestrationControlPlane(db, 'controller-b')
    second.useRun(run.id)

    let staleError: unknown
    try {
      first.createTask({ spec: 'stale mutation' })
    } catch (error) {
      staleError = error
    }

    expect(staleError).toMatchObject({ code: 'consumer_fenced' })
    expect(second.createTask({ spec: 'current mutation' }).run_id).toBe(run.id)
  })
})

function createDatabase(): OrchestrationDb {
  const dir = mkdtempSync(join(tmpdir(), 'orca-control-plane-'))
  const db = new OrchestrationDb(join(dir, 'orchestration.db'))
  databases.push({ db, dir })
  return db
}
