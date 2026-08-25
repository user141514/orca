import type { OrcaRuntimeService } from '../orca-runtime'
import { getMissingCollaborationPublicationTopics } from './collaboration-publication-obligations'

export type CollaborationWorkerCompletionBlock = {
  code: 'collaboration_publish_incomplete'
  reason: string
}

export function getCollaborationWorkerCompletionBlock(
  runtime: OrcaRuntimeService,
  runId: string,
  taskId: string
): CollaborationWorkerCompletionBlock | null {
  const missingTopics = getMissingCollaborationPublicationTopics(runtime, runId, taskId)
  if (missingTopics.length === 0) {
    return null
  }
  return {
    code: 'collaboration_publish_incomplete',
    reason: `Task ${taskId} must publish required collaboration topics before succeeded worker_done: ${missingTopics.join(', ')}`
  }
}
