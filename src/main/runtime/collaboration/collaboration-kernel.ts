import type { CollaborationExecutionPort } from './collaboration-execution-port'
import type { CollaborationPlan, CollaborationRunReceipt } from './types'

export class CollaborationKernel {
  constructor(private readonly execution: CollaborationExecutionPort) {}

  start(plan: CollaborationPlan): Promise<CollaborationRunReceipt> {
    return this.execution.start(plan)
  }
}
