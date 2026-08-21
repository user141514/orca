import type { OrchestrationDb } from './db'
import type { OrchestrationExecutor } from './orchestration-control-plane'

export class OrchestrationExecutorRouter implements OrchestrationExecutor {
  private readonly executors: ReadonlyMap<string, OrchestrationExecutor>

  constructor(
    private readonly db: OrchestrationDb,
    executors: Record<string, OrchestrationExecutor>
  ) {
    this.executors = new Map(Object.entries(executors))
  }

  async execute(input: Parameters<OrchestrationExecutor['execute']>[0]): Promise<void> {
    const backend = input.execution?.backend
    const executor = backend ? this.executors.get(backend) : undefined
    if (executor) {
      await executor.execute(input)
      return
    }

    const worker = this.db.getWorkerDispatch(input.dispatchId)
    if (worker?.state !== 'starting') {
      return
    }
    this.db.failWorkerStart(
      input.dispatchId,
      'executor_route',
      backend
        ? `No orchestration executor is registered for backend ${backend}.`
        : 'Task has no execution backend.'
    )
  }
}
