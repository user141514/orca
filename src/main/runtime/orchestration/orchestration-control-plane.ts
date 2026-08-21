import type { OrchestrationDb } from './db'
import type { RunCoordinationLease } from './db/runs/run-consumer'
import type { RunRow, TaskExecutionDescriptor, TaskRow, TaskStatus } from './types'

export type OrchestrationPlanTask = {
  key: string
  spec: string
  taskTitle?: string
  displayName?: string
  deps?: string[]
  execution?: TaskExecutionDescriptor
}

export type OrchestrationPlan = {
  objective: string
  maxConcurrency: number
  tasks: OrchestrationPlanTask[]
}

export type MaterializedOrchestrationPlan = {
  run: RunRow
  tasksByKey: Record<string, TaskRow>
  maxConcurrency: number
}

export class OrchestrationControlPlane {
  private lease: RunCoordinationLease | undefined

  constructor(
    private readonly db: OrchestrationDb,
    private readonly consumerId: string
  ) {}

  createRun(objective: string): RunRow {
    const created = this.db.createRun({ objective })
    this.lease = this.db.acquireRunConsumer({ runId: created.id, consumerId: this.consumerId })
    return this.db.getRun(created.id) as RunRow
  }

  useRun(runId: string): RunRow {
    this.lease = this.db.acquireRunConsumer({ runId, consumerId: this.consumerId })
    return this.db.getRun(runId) as RunRow
  }

  startPlan(plan: OrchestrationPlan): MaterializedOrchestrationPlan {
    validatePlan(plan)
    const run = this.createRun(plan.objective)
    this.db.setRunControlPolicy(this.requireLease(), { maxConcurrency: plan.maxConcurrency })
    const pending = new Map(plan.tasks.map((task) => [task.key, task]))
    const tasksByKey: Record<string, TaskRow> = {}

    while (pending.size > 0) {
      let progressed = false
      for (const [key, task] of pending) {
        const deps = task.deps ?? []
        if (!deps.every((dependency) => tasksByKey[dependency])) {
          continue
        }
        tasksByKey[key] = this.createTask({
          spec: task.spec,
          taskTitle: task.taskTitle,
          displayName: task.displayName,
          deps: deps.map((dependency) => tasksByKey[dependency]!.id),
          execution: task.execution
        })
        pending.delete(key)
        progressed = true
      }
      if (!progressed) {
        throw new Error('Orchestration plan contains a dependency cycle.')
      }
    }

    return { run, tasksByKey, maxConcurrency: plan.maxConcurrency }
  }

  createTask(task: {
    spec: string
    taskTitle?: string
    displayName?: string
    deps?: string[]
    parentId?: string
    execution?: TaskExecutionDescriptor
  }): TaskRow {
    return this.db.createTaskForConsumer(this.requireLease(), task)
  }

  listTasks(filter?: { status?: TaskStatus; ready?: boolean }): TaskRow[] {
    return this.db.listTasks({ ...filter, runId: this.requireLease().runId })
  }

  acceptTask(
    taskId: string,
    startOptions: unknown = {}
  ): ReturnType<OrchestrationDb['createStartingWorkerDispatch']> {
    return this.db.createStartingWorkerDispatch({
      taskId,
      startOptions,
      coordinationLease: this.requireLease()
    })
  }

  getLease(): RunCoordinationLease {
    return { ...this.requireLease() }
  }

  private requireLease(): RunCoordinationLease {
    if (!this.lease) {
      throw new Error('No Run is attached to this orchestration control plane.')
    }
    return this.lease
  }
}

export type OrchestrationSchedulerTick = {
  state: 'running' | 'completed' | 'blocked'
  started: {
    taskId: string
    dispatchId: string
    execution: TaskExecutionDescriptor | null
  }[]
  active: number
}

export class OrchestrationScheduler {
  private readonly control: OrchestrationControlPlane
  private runId: string | undefined

  constructor(
    private readonly db: OrchestrationDb,
    consumerId: string
  ) {
    this.control = new OrchestrationControlPlane(db, consumerId)
  }

  useRun(runId: string): void {
    this.control.useRun(runId)
    this.runId = runId
  }

  tick(): OrchestrationSchedulerTick {
    const runId = this.requireRunId()
    const policy = this.db.getRunControlPolicy(runId)
    if (!policy) {
      throw new Error(`Run ${runId} has no control policy.`)
    }

    const before = this.control.listTasks()
    const activeBefore = before.filter((task) => task.status === 'dispatched').length
    const capacity = Math.max(0, policy.maxConcurrency - activeBefore)
    const started = before
      .filter((task) => task.status === 'ready')
      .slice(0, capacity)
      .map((task) => {
        const execution = parseTaskExecutionDescriptor(task.execution_spec)
        const accepted = this.control.acceptTask(task.id, execution ? { execution } : {})
        return { taskId: task.id, dispatchId: accepted.dispatch.id, execution }
      })

    const after = this.control.listTasks()
    const active = after.filter((task) => task.status === 'dispatched').length
    const ready = after.some((task) => task.status === 'ready')
    const completed = after.every((task) => task.status === 'completed')
    const state = completed ? 'completed' : active === 0 && !ready ? 'blocked' : 'running'
    return { state, started, active }
  }

  private requireRunId(): string {
    if (!this.runId) {
      throw new Error('No Run is attached to this orchestration scheduler.')
    }
    return this.runId
  }
}

export type OrchestrationExecutor = {
  execute(input: {
    runId: string
    taskId: string
    dispatchId: string
    execution: TaskExecutionDescriptor | null
  }): Promise<void> | void
}

export class DeterministicOrchestrationRunner {
  constructor(
    private readonly db: OrchestrationDb,
    private readonly consumerId: string,
    private readonly executor: OrchestrationExecutor
  ) {}

  async runPlan(
    plan: OrchestrationPlan
  ): Promise<{ runId: string; state: OrchestrationSchedulerTick['state'] }> {
    const control = new OrchestrationControlPlane(this.db, this.consumerId)
    const materialized = control.startPlan(plan)
    const scheduler = new OrchestrationScheduler(this.db, this.consumerId)
    scheduler.useRun(materialized.run.id)

    for (;;) {
      const tick = scheduler.tick()
      if (tick.started.length === 0) {
        if (tick.state === 'running' && tick.active > 0) {
          throw new Error(
            `Run ${materialized.run.id} still has active Dispatches after the executor returned.`
          )
        }
        return { runId: materialized.run.id, state: tick.state }
      }
      await Promise.all(
        tick.started.map((entry) =>
          Promise.resolve(
            this.executor.execute({
              runId: materialized.run.id,
              taskId: entry.taskId,
              dispatchId: entry.dispatchId,
              execution: entry.execution
            })
          )
        )
      )
    }
  }
}

function validatePlan(plan: OrchestrationPlan): void {
  if (!Number.isSafeInteger(plan.maxConcurrency) || plan.maxConcurrency < 1) {
    throw new Error('Orchestration plan maxConcurrency must be a positive integer.')
  }
  const keys = new Set<string>()
  for (const task of plan.tasks) {
    if (!task.key) {
      throw new Error('Orchestration plan task key is required.')
    }
    if (keys.has(task.key)) {
      throw new Error(`Duplicate orchestration plan task key: ${task.key}`)
    }
    if (task.execution && !task.execution.backend.trim()) {
      throw new Error(`Orchestration plan task ${task.key} has an empty execution backend.`)
    }
    keys.add(task.key)
  }
  for (const task of plan.tasks) {
    for (const dependency of task.deps ?? []) {
      if (!keys.has(dependency)) {
        throw new Error(`Unknown orchestration plan dependency: ${dependency}`)
      }
    }
  }
}

function parseTaskExecutionDescriptor(serialized: string | null): TaskExecutionDescriptor | null {
  if (!serialized) {
    return null
  }
  const parsed: unknown = JSON.parse(serialized)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    typeof (parsed as { backend?: unknown }).backend !== 'string' ||
    !(parsed as { backend: string }).backend.trim()
  ) {
    throw new Error('Stored Task execution descriptor is invalid.')
  }
  return parsed as TaskExecutionDescriptor
}
