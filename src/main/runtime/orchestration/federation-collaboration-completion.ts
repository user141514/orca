import type { OrcaRuntimeService } from '../orca-runtime'
import { getCollaborationWorkerCompletionBlock } from '../collaboration-runtime/collaboration-worker-completion-guard'
import type { WorkerReportOutcome } from './types'

export type FederatedImportedLifecycle =
  | { kind: 'none' }
  | { kind: 'heartbeat'; at: string }
  | {
      kind: 'worker_report'
      taskId: string
      outcome: WorkerReportOutcome
      result: string
    }
  | { kind: 'rejected'; code: string; reason: string }

export function applyFederatedCollaborationCompletionGuard(
  runtime: OrcaRuntimeService,
  runId: string,
  lifecycle: FederatedImportedLifecycle
): FederatedImportedLifecycle {
  if (lifecycle.kind !== 'worker_report' || lifecycle.outcome !== 'succeeded') {
    return lifecycle
  }
  const completionBlock = getCollaborationWorkerCompletionBlock(runtime, runId, lifecycle.taskId)
  return completionBlock
    ? { kind: 'rejected', code: completionBlock.code, reason: completionBlock.reason }
    : lifecycle
}
