import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationExecutor } from '../../orchestration/orchestration-control-plane'
import type { TaskExecutionDescriptor } from '../../orchestration/types'
import {
  provisionAcceptedLocalWorker,
  type LocalWorkerTaskProtocolInstructionBuilder
} from './orchestration-local-worker-provision'
import { resolveWorkerLaunchPreferences } from './orchestration-worker-launch-preferences'

type LocalWorkerExecutionConfig = {
  worktreeId: string
  agent: TuiAgent
  model?: string
  effort?: string
  timeoutMs: number
  devMode?: boolean
}

export type LocalWorkerTaskInputResolver = (input: {
  taskId: string
  runId: string
  spec: string
  dependencies: { taskId: string; result: string | null }[]
}) => string | Promise<string>

type LocalWorkerExecutorOptions = {
  resolveTaskInput?: LocalWorkerTaskInputResolver
  buildTaskProtocolInstructions?: LocalWorkerTaskProtocolInstructionBuilder
}

export class LocalWorkerExecutor implements OrchestrationExecutor {
  constructor(
    private readonly runtime: OrcaRuntimeService,
    private readonly options: LocalWorkerExecutorOptions = {}
  ) {}

  async execute(input: Parameters<OrchestrationExecutor['execute']>[0]): Promise<void> {
    const db = this.runtime.getOrchestrationDb()
    const task = db.getTask(input.taskId)
    const dispatch = db.getDispatchContextById(input.dispatchId)
    if (!task || task.run_id !== input.runId || !dispatch || dispatch.task_id !== task.id) {
      throw new Error(`Dispatch ${input.dispatchId} does not belong to Task ${input.taskId}.`)
    }

    let config: LocalWorkerExecutionConfig
    let taskSpec = task.spec
    try {
      config = parseLocalWorkerExecution(input.execution)
      if (this.options.resolveTaskInput) {
        taskSpec = await this.options.resolveTaskInput({
          taskId: task.id,
          runId: input.runId,
          spec: task.spec,
          dependencies: readTaskDependencyResults(db, task.deps)
        })
      }
      const workspace = await this.runtime.showManagedTerminalWorkspace(`id:${config.worktreeId}`)
      if (workspace.id !== config.worktreeId) {
        throw new Error(`Workspace ${config.worktreeId} resolved as ${workspace.id}.`)
      }
      this.runtime.validateOrchestrationAgentLauncher(config.agent)
    } catch (error) {
      failAcceptedDispatch(db, input.dispatchId, error)
      return
    }

    const launch = resolveWorkerLaunchPreferences({
      agent: config.agent,
      model: config.model,
      effort: config.effort
    })
    await provisionAcceptedLocalWorker({
      runtime: this.runtime,
      db,
      runId: input.runId,
      task: { id: task.id, spec: taskSpec },
      dispatchId: input.dispatchId,
      coordinatorAddress: `run:${input.runId}`,
      placement: { kind: 'existing-workspace', worktreeId: config.worktreeId },
      agent: config.agent,
      launch,
      timeoutMs: config.timeoutMs,
      devMode: config.devMode,
      buildTaskProtocolInstructions: this.options.buildTaskProtocolInstructions
    })
  }
}

function parseLocalWorkerExecution(
  execution: TaskExecutionDescriptor | null
): LocalWorkerExecutionConfig {
  if (!execution || execution.backend !== 'local-worker') {
    throw new Error('Task execution backend must be local-worker.')
  }
  if (
    !execution.config ||
    typeof execution.config !== 'object' ||
    Array.isArray(execution.config)
  ) {
    throw new Error('local-worker execution config must be an object.')
  }
  const config = execution.config as Record<string, unknown>
  const worktreeId = readNonEmptyString(config, 'worktreeId')
  const agentValue = readNonEmptyString(config, 'agent')
  if (!isTuiAgent(agentValue)) {
    throw new Error(`Unsupported local-worker agent: ${agentValue}`)
  }
  const model = readOptionalString(config, 'model')
  const effort = readOptionalString(config, 'effort')
  const timeoutMs = readOptionalPositiveNumber(config, 'timeoutMs') ?? 60_000
  const devMode = readOptionalBoolean(config, 'devMode')
  return {
    worktreeId,
    agent: agentValue,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    timeoutMs,
    ...(devMode === undefined ? {} : { devMode })
  }
}

function readTaskDependencyResults(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  serializedDeps: string
): { taskId: string; result: string | null }[] {
  const parsed: unknown = JSON.parse(serializedDeps)
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    throw new Error('Task dependencies must be a JSON array of task IDs.')
  }
  return parsed.map((taskId) => {
    const dependency = db.getTask(taskId)
    if (!dependency) {
      throw new Error(`Task dependency ${taskId} does not exist.`)
    }
    return { taskId, result: dependency.result }
  })
}

function readNonEmptyString(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`local-worker execution config requires ${key}.`)
  }
  return value
}

function readOptionalString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`local-worker execution config ${key} must be a non-empty string.`)
  }
  return value
}

function readOptionalPositiveNumber(
  config: Record<string, unknown>,
  key: string
): number | undefined {
  const value = config[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`local-worker execution config ${key} must be positive.`)
  }
  return value
}

function readOptionalBoolean(config: Record<string, unknown>, key: string): boolean | undefined {
  const value = config[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`local-worker execution config ${key} must be boolean.`)
  }
  return value
}

function failAcceptedDispatch(
  db: ReturnType<OrcaRuntimeService['getOrchestrationDb']>,
  dispatchId: string,
  error: unknown
): void {
  const worker = db.getWorkerDispatch(dispatchId)
  if (worker?.state !== 'starting') {
    return
  }
  db.failWorkerStart(
    dispatchId,
    'execution_config',
    error instanceof Error ? error.message : String(error)
  )
}
