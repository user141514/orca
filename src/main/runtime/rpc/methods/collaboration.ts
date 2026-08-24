import { z } from 'zod'
import { getCollaborationRuntimeSession } from '../../collaboration-runtime/collaboration-runtime-registry'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DispatchContextRow } from '../../orchestration/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CHECKPOINT_LEASE_MS = 60_000
const CHECKPOINT_LIMIT = 50

const CollaborationAuthorityParams = z.object({
  from: requiredString('Collaboration checkpoint requires a sender terminal'),
  taskId: requiredString('Collaboration checkpoint requires a task ID'),
  dispatchId: requiredString('Collaboration checkpoint requires a Dispatch ID')
})

const CollaborationCheckpointParams = CollaborationAuthorityParams
const CollaborationCheckpointAckParams = CollaborationAuthorityParams.extend({
  acknowledgements: z
    .array(
      z.object({
        deliveryId: requiredString('Collaboration acknowledgement requires a delivery ID'),
        deliveryAttempt: z.number().int().min(1)
      })
    )
    .max(CHECKPOINT_LIMIT)
})

type CollaborationAuthorityInput = z.infer<typeof CollaborationAuthorityParams>

export const COLLABORATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'collaboration.checkpoint',
    params: CollaborationCheckpointParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
      const dispatch = requireCollaborationDispatchAuthority(
        params,
        runtime,
        orchestrationCapability
      )
      const session = requireCollaborationSession(runtime, dispatch)
      const nowMs = Date.now()
      return {
        entries: session.prepareCheckpoint({
          taskId: params.taskId,
          nowMs,
          leaseMs: CHECKPOINT_LEASE_MS,
          limit: CHECKPOINT_LIMIT
        })
      }
    }
  }),
  defineMethod({
    name: 'collaboration.checkpoint-ack',
    params: CollaborationCheckpointAckParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
      const dispatch = requireCollaborationDispatchAuthority(
        params,
        runtime,
        orchestrationCapability
      )
      const session = requireCollaborationSession(runtime, dispatch)
      return session.acknowledgeCheckpoint({
        taskId: params.taskId,
        nowMs: Date.now(),
        acknowledgements: params.acknowledgements
      })
    }
  })
]

function requireCollaborationDispatchAuthority(
  params: CollaborationAuthorityInput,
  runtime: OrcaRuntimeService,
  orchestrationCapability: string | undefined
): DispatchContextRow {
  const db = runtime.getOrchestrationDb()
  const dispatch = db.getDispatchContextById(params.dispatchId)
  if (!dispatch) {
    throw new OrchestrationError(
      'dispatch_not_found',
      `Dispatch ${params.dispatchId} was not found.`
    )
  }
  if (!['pending', 'dispatched'].includes(dispatch.status)) {
    throw new OrchestrationError(
      'dispatch_inactive',
      `Dispatch ${params.dispatchId} is not active.`
    )
  }
  if (dispatch.task_id !== params.taskId) {
    throw new OrchestrationError(
      'task_dispatch_mismatch',
      `Task ${params.taskId} does not belong to Dispatch ${params.dispatchId}.`
    )
  }

  const paneKey = runtime.getTerminalPaneKey(params.from) ?? undefined
  const senderMatches =
    dispatch.assignee_handle === params.from ||
    db.isDispatchMessageSender({
      dispatchId: params.dispatchId,
      handle: params.from,
      paneKey
    })
  if (!senderMatches) {
    throw new OrchestrationError(
      'sender_not_assignee',
      `Terminal ${params.from} does not own Dispatch ${params.dispatchId}.`
    )
  }

  const processIncarnation = runtime.getTerminalProcessIncarnation(params.from) ?? undefined
  const authority = db.verifyDispatchCapability({
    dispatchId: params.dispatchId,
    capability: orchestrationCapability,
    paneKey,
    processIncarnation
  })
  if (!authority.valid) {
    throw new OrchestrationError('dispatch_capability_invalid', authority.reason)
  }
  return dispatch
}

function requireCollaborationSession(runtime: OrcaRuntimeService, dispatch: DispatchContextRow) {
  const session = getCollaborationRuntimeSession(runtime, dispatch.run_id)
  if (!session) {
    throw new OrchestrationError(
      'collaboration_session_unavailable',
      `Collaboration session for Run ${dispatch.run_id} is unavailable.`
    )
  }
  return session
}
