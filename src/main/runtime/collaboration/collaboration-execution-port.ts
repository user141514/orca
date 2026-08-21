import type { CollaborationPlan, CollaborationRunReceipt } from './types'

export type CollaborationExecutionPort = {
  start(plan: CollaborationPlan): Promise<CollaborationRunReceipt>
}
