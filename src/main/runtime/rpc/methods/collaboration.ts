import { z } from 'zod'
import type { CollaborationAdmissionContextEntry } from '../../collaboration/collaboration-admission'
import { getCollaborationRuntimeSession } from '../../collaboration-runtime/collaboration-runtime-registry'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CHECKPOINT_LEASE_MS = 60_000
const CHECKPOINT_LIMIT = 50

const CollaborationCheckpointParams = z.object({
  from: requiredString('Collaboration checkpoint requires a sender terminal'),
  taskId: requiredString('Collaboration checkpoint requires a task ID'),
  dispatchId: requiredString('Collaboration checkpoint requires a Dispatch ID')
})

export const COLLABORATION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'collaboration.checkpoint',
    params: CollaborationCheckpointParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
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

      const session = getCollaborationRuntimeSession(runtime, dispatch.run_id)
      if (!session) {
        throw new OrchestrationError(
          'collaboration_session_unavailable',
          `Collaboration session for Run ${dispatch.run_id} is unavailable.`
        )
      }

      const nowMs = Date.now()
      session.releaseExpired(nowMs)
      let entries: readonly CollaborationAdmissionContextEntry[] = []
      await session.checkpoint({
        taskId: params.taskId,
        nowMs,
        leaseMs: CHECKPOINT_LEASE_MS,
        limit: CHECKPOINT_LIMIT,
        commitContext: async (value) => {
          entries = value
        }
      })
      return { entries }
    }
  })
]
