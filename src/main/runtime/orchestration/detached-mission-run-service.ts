import type { MissionPlanTask } from '../mission/mission-plan'
import { createCollaborationTopology } from '../collaboration/collaboration-topology'
import type { OrchestrationDb } from './db'
import { OrchestrationError } from './orchestration-error'
import type { DetachedMissionRunRow, MessageRow } from './types'

const RETRYABLE_WORKER_START_STAGES = new Set(['terminal_create', 'agent_readiness'])

export type DetachedMissionWorkerStart = {
  taskId: string
  runId: string
  worktreeId: string | null
  agent: string
  model?: string
  effort?: string
  retryOf?: string
}

export type DetachedMissionWorkerResult = {
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
}

type DetachedMissionPlan = {
  tasks: MissionPlanTask[]
}

type DetachedMissionWorkers = {
  agent: string
  agentCandidates?: string[]
  model?: string
  effort?: string
}

export class DetachedMissionRunService {
  private readonly supervising = new Map<string, Promise<void>>()
  private readonly superviseAgain = new Set<string>()
  private readonly collaborationConfigured = new Set<string>()

  constructor(
    private readonly deps: {
      db: OrchestrationDb
      startWorker: (input: DetachedMissionWorkerStart) => Promise<DetachedMissionWorkerResult>
      configureCollaboration?: (input: {
        runId: string
        topology: ReturnType<typeof createCollaborationTopology>
      }) => void
      stopWorker?: (dispatchId: string) => Promise<void>
    }
  ) {}

  create(input: {
    objective: string
    worktreeId: string | null
    plannerSelection: { tasks?: MissionPlanTask[]; [key: string]: unknown }
    workerSelection: DetachedMissionWorkers
    tasks: MissionPlanTask[]
    maxConcurrency: number
    ownerFingerprint: string
    stopSecretHash: string
  }) {
    const plan: DetachedMissionPlan = { tasks: input.tasks }
    return this.deps.db.createDetachedMissionRun({
      objective: input.objective,
      worktreeId: input.worktreeId,
      plannerSelectionJson: JSON.stringify({ ...input.plannerSelection, plan }),
      workerSelectionJson: JSON.stringify(input.workerSelection),
      maxConcurrency: input.maxConcurrency,
      ownerFingerprint: input.ownerFingerprint,
      stopSecretHash: input.stopSecretHash
    })
  }

  async rehydrate(): Promise<void> {
    await Promise.all(this.deps.db.listRehydratableDetachedMissionRuns().map((mission) => this.supervise(mission.run_id)))
  }

  show(runId: string) {
    const mission = this.deps.db.readDetachedMissionRun(runId)
    if (!mission) {
      throw new OrchestrationError('run_not_found', `Detached mission ${runId} was not found.`)
    }
    const tasks = this.deps.db.listTasksWithDispatch({ runId })
    const questions = this.deps.db.listQuestions(runId).filter((question) => question.status === 'pending')
    return {
      runId,
      lifecycle: mission.lifecycle,
      counts: {
        total: tasks.length,
        pending: tasks.filter((task) => task.status === 'pending').length,
        ready: tasks.filter((task) => task.status === 'ready').length,
        dispatched: tasks.filter((task) => task.status === 'dispatched').length,
        completed: tasks.filter((task) => task.status === 'completed').length,
        failed: tasks.filter((task) => task.status === 'failed').length
      },
      questions,
      lastError: mission.last_error
    }
  }

  async supervise(runId: string): Promise<void> {
    const current = this.supervising.get(runId)
    if (current) {
      this.superviseAgain.add(runId)
      return current
    }
    const work = (async () => {
      do {
        this.superviseAgain.delete(runId)
        await this.superviseOnce(runId)
      } while (this.superviseAgain.delete(runId))
    })().finally(() => {
      this.supervising.delete(runId)
      this.superviseAgain.delete(runId)
    })
    this.supervising.set(runId, work)
    return work
  }

  async answer(runId: string, questionId: string, body: string): Promise<void> {
    const mission = this.requireActive(runId)
    const run = this.deps.db.getRun(runId)
    if (!run) {
      throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`)
    }
    this.deps.db.answerQuestion({
      messageId: questionId,
      runId,
      consumerGeneration: run.consumer_generation,
      body
    })
    if (mission.lifecycle === 'awaiting_input') {
      this.deps.db.updateDetachedMissionRun(runId, { lifecycle: 'running' })
    }
  }

  async stop(runId: string, reason = 'stopped'): Promise<void> {
    const mission = this.requireActive(runId)
    const nextGeneration = mission.supervisor_generation + 1
    this.deps.db.updateDetachedMissionRun(runId, {
      lifecycle: 'stopping',
      supervisorGeneration: nextGeneration,
      lastError: reason
    })
    const active = this.deps.db.listTasksWithDispatch({ runId }).filter((task) => task.dispatch_id)
    await Promise.all(active.map(async (task) => {
      this.deps.db.revokeDispatchCapability(task.dispatch_id!)
      await this.deps.stopWorker?.(task.dispatch_id!)
    }))
    this.deps.db.updateDetachedMissionRun(runId, {
      lifecycle: 'stopped',
      terminalOutcome: 'stopped',
      lastError: reason
    })
  }

  private async superviseOnce(runId: string): Promise<void> {
    const mission = this.requireActive(runId)
    if (mission.lifecycle === 'stopping' || mission.lifecycle === 'awaiting_input') {
      return
    }
    const { plan, workers } = this.decode(mission)
    this.materialize(runId, plan.tasks)
    this.ensureCollaborationConfigured(runId, plan.tasks)
    let supervisorGeneration = mission.supervisor_generation
    if (mission.lifecycle === 'queued') {
      supervisorGeneration += 1
      this.deps.db.updateDetachedMissionRun(runId, {
        lifecycle: 'running',
        supervisorGeneration
      })
    }
    const run = this.deps.db.getRun(runId)
    if (!run) {
      return
    }
    const delivery = this.deps.db.getOrCreateRunDelivery({
      runId,
      consumerGeneration: run.consumer_generation
    })
    if (delivery) {
      const paused = this.consume(runId, delivery.messages)
      this.deps.db.acknowledgeRunDelivery({
        runId,
        consumerGeneration: run.consumer_generation,
        deliveryId: delivery.delivery.id
      })
      if (paused) {
        return
      }
    }
    const tasks = this.deps.db.listTasksWithDispatch({ runId })
    const failed = tasks.filter((task) => task.status === 'failed')
    if (tasks.length > 0 && tasks.every((task) => task.status === 'completed' || task.status === 'failed')) {
      this.deps.db.updateDetachedMissionRun(runId, {
        lifecycle: failed.length === 0 ? 'succeeded' : 'failed',
        terminalOutcome: failed.length === 0 ? 'succeeded' : 'failed',
        lastError: failed.length === 0 ? null : `${failed.length} task(s) failed.`
      })
      return
    }
    const capacity = mission.max_concurrency - tasks.filter((task) => task.status === 'dispatched').length
    if (capacity <= 0) {
      return
    }
    const wave = tasks.filter((task) => task.status === 'ready').slice(0, capacity)
    if (wave.length === 0) {
      if (!tasks.some((task) => task.status === 'dispatched')) {
        this.deps.db.updateDetachedMissionRun(runId, {
          lifecycle: 'failed', terminalOutcome: 'failed', lastError: 'Mission stalled with no ready or active tasks.'
        })
      }
      return
    }
    try {
      await Promise.all(
        wave.map((task) =>
          this.startWithCandidates(
            runId,
            task.id,
            mission.worktree_id,
            workers,
            supervisorGeneration
          )
        )
      )
    } catch (error) {
      const current = this.deps.db.readDetachedMissionRun(runId)
      if (
        current &&
        !current.terminal_outcome &&
        current.supervisor_generation === supervisorGeneration
      ) {
        this.deps.db.updateDetachedMissionRun(runId, {
          lifecycle: 'failed',
          terminalOutcome: 'failed',
          lastError: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
  }

  private materialize(runId: string, tasks: readonly MissionPlanTask[]): void {
    if (this.deps.db.listTasks({ runId }).length > 0) {
      return
    }
    const ids = new Map<string, string>()
    for (const task of orderTasks(tasks)) {
      const deps = task.deps.map((key) => {
        const id = ids.get(key)
        if (!id) {
          throw new OrchestrationError(
            'mission_plan_invalid',
            `Unknown Mission dependency: ${key}`
          )
        }
        return id
      })
      const created = this.deps.db.createTask({ spec: task.spec, taskTitle: task.key, displayName: task.key, deps, runId })
      ids.set(task.key, created.id)
    }
  }

  private ensureCollaborationConfigured(runId: string, tasks: readonly MissionPlanTask[]): void {
    if (this.collaborationConfigured.has(runId)) {
      return
    }
    if (this.deps.configureCollaboration && tasks.some(hasCollaborationIntent)) {
      const byKey = new Map(
        this.deps.db.listTasks({ runId }).map((task) => [task.task_title, task.id])
      )
      this.deps.configureCollaboration({
        runId,
        topology: createCollaborationTopology(
          tasks.map((task) => ({
            taskId: byKey.get(task.key)!,
            publishesTo: task.publishesTo,
            requiredPublishesTo: task.requiredPublishesTo,
            subscribesTo: task.subscribesTo,
            admission: task.admission
          }))
        )
      })
    }
    this.collaborationConfigured.add(runId)
  }

  private consume(runId: string, messages: readonly MessageRow[]): boolean {
    let awaitingInput = false
    let escalation: MessageRow | undefined
    for (const message of messages) {
      if (message.type === 'question') {
        awaitingInput = true
      } else if (message.type === 'escalation' && !escalation) {
        escalation = message
      }
    }
    if (escalation) {
      this.deps.db.updateDetachedMissionRun(runId, {
        lifecycle: 'failed',
        terminalOutcome: 'failed',
        lastError: escalation.body || escalation.subject
      })
      return true
    }
    if (awaitingInput) {
      this.deps.db.updateDetachedMissionRun(runId, { lifecycle: 'awaiting_input' })
      return true
    }
    return false
  }

  private async startWithCandidates(
    runId: string,
    taskId: string,
    worktreeId: string | null,
    workers: DetachedMissionWorkers,
    supervisorGeneration: number
  ): Promise<void> {
    const candidates = workers.agentCandidates?.length ? workers.agentCandidates : [workers.agent]
    let retryOf: string | undefined
    const failures: string[] = []
    for (const [index, agent] of candidates.entries()) {
      if (!this.isSupervisorCurrent(runId, supervisorGeneration)) {
        return
      }
      const result = await this.deps.startWorker({
        taskId,
        runId,
        worktreeId,
        agent,
        model: workers.model,
        effort: workers.effort,
        retryOf
      })
      if (!this.isSupervisorCurrent(runId, supervisorGeneration)) {
        if (result.state === 'ready') {
          this.deps.db.revokeDispatchCapability(result.dispatchId)
          await this.deps.stopWorker?.(result.dispatchId)
        }
        return
      }
      if (result.state === 'ready') {
        return
      }
      if (
        index + 1 < candidates.length &&
        result.failedStage &&
        RETRYABLE_WORKER_START_STAGES.has(result.failedStage)
      ) {
        retryOf = result.dispatchId
        failures.push(`${agent}: ${result.lastError ?? result.failedStage}`)
        continue
      }
      throw new OrchestrationError('mission_worker_start_failed', result.lastError ?? `Worker ${result.dispatchId} failed to become ready.`)
    }
    throw new OrchestrationError('mission_worker_start_failed', `No mission agent could start task ${taskId}: ${failures.join('; ')}`)
  }

  private isSupervisorCurrent(runId: string, supervisorGeneration: number): boolean {
    const mission = this.deps.db.readDetachedMissionRun(runId)
    return Boolean(
      mission &&
        !mission.terminal_outcome &&
        mission.lifecycle !== 'stopping' &&
        mission.supervisor_generation === supervisorGeneration
    )
  }

  private requireActive(runId: string): DetachedMissionRunRow {
    const mission = this.deps.db.readDetachedMissionRun(runId)
    if (!mission || mission.terminal_outcome) {
      throw new OrchestrationError('run_not_found', `Detached mission ${runId} is not active.`)
    }
    return mission
  }

  private decode(mission: DetachedMissionRunRow): { plan: DetachedMissionPlan; workers: DetachedMissionWorkers } {
    const planner = JSON.parse(mission.planner_selection_json) as { plan?: DetachedMissionPlan }
    const workers = JSON.parse(mission.worker_selection_json) as DetachedMissionWorkers
    if (!planner.plan || !Array.isArray(planner.plan.tasks) || !workers.agent) {
      throw new OrchestrationError(
        'mission_plan_invalid',
        'Detached mission has invalid persisted configuration.'
      )
    }
    return { plan: planner.plan, workers }
  }
}

function hasCollaborationIntent(task: MissionPlanTask): boolean {
  return Boolean(task.publishesTo?.length || task.requiredPublishesTo?.length || task.subscribesTo?.length || task.admission)
}

function orderTasks(tasks: readonly MissionPlanTask[]): MissionPlanTask[] {
  const byKey = new Map(tasks.map((task) => [task.key, task]))
  const ordered: MissionPlanTask[] = []
  const emitted = new Set<string>()
  while (ordered.length < tasks.length) {
    const before = ordered.length
    for (const task of tasks) {
      if (!emitted.has(task.key) && task.deps.every((dep) => emitted.has(dep))) {
        if (task.deps.some((dep) => !byKey.has(dep))) {
          throw new OrchestrationError(
            'mission_plan_invalid',
            `Unknown Mission dependency in task ${task.key}.`
          )
        }
        emitted.add(task.key)
        ordered.push(task)
      }
    }
    if (before === ordered.length) {
      throw new OrchestrationError('mission_plan_invalid', 'Mission task dependency cycle detected.')
    }
  }
  return ordered
}
