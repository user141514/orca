import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { noteCollaborationPublication } from '../../collaboration-runtime/collaboration-publication-obligations'
import { getCollaborationRuntimeSession } from '../../collaboration-runtime/collaboration-runtime-registry'
import type { CollaborationPreparedContextEntry } from '../../collaboration/collaboration-checkpoint-delivery'
import {
  CollaborationPublicationConflictError,
  CollaborationPublishTopicError
} from '../../collaboration/collaboration-runtime-session'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { DispatchContextRow } from '../../orchestration/types'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const CHECKPOINT_LEASE_MS = 60_000
const CHECKPOINT_LIMIT = 50
const CHECKPOINT_WAIT_DEFAULT_TIMEOUT_MS = 60_000
const CHECKPOINT_WAIT_MAX_TIMEOUT_MS = 600_000

const CollaborationAuthorityParams = z.object({
  from: requiredString('Collaboration checkpoint requires a sender terminal'),
  taskId: requiredString('Collaboration checkpoint requires a task ID'),
  dispatchId: requiredString('Collaboration checkpoint requires a Dispatch ID')
})

const CollaborationPublishParams = CollaborationAuthorityParams.extend({
  publicationId: requiredString('Collaboration publish requires a publication ID'),
  topic: requiredString('Collaboration publish requires a topic'),
  type: requiredString('Collaboration publish requires a message type'),
  priority: z.enum(['normal', 'high', 'urgent']),
  body: requiredString('Collaboration publish requires a body')
})

const CollaborationCheckpointParams = CollaborationAuthorityParams.extend({
  wait: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(CHECKPOINT_WAIT_MAX_TIMEOUT_MS).optional()
})
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
    name: 'collaboration.publish',
    params: CollaborationPublishParams,
    handler: async (params, { runtime, orchestrationCapability }) => {
      const dispatch = requireCollaborationDispatchAuthority(
        params,
        runtime,
        orchestrationCapability
      )
      const session = requireCollaborationSession(runtime, dispatch)
      try {
        const result = session.publishFromTask({
          taskId: params.taskId,
          message: {
            id: params.publicationId,
            topic: params.topic,
            type: params.type,
            priority: params.priority,
            body: params.body
          },
          deliveryIdFor: () => `collab_delivery_${randomUUID()}`
        })
        noteCollaborationPublication(runtime, dispatch.run_id, params.taskId, params.topic)
        return { messageId: params.publicationId, ...result }
      } catch (error) {
        if (error instanceof CollaborationPublicationConflictError) {
          throw new OrchestrationError('collaboration_publication_conflict', error.message)
        }
        if (error instanceof CollaborationPublishTopicError) {
          throw new OrchestrationError('collaboration_topic_not_allowed', error.message)
        }
        throw error
      }
    }
  }),
  defineMethod({
    name: 'collaboration.checkpoint',
    params: CollaborationCheckpointParams,
    handler: async (params, { runtime, orchestrationCapability, signal }) => {
      const dispatch = requireCollaborationDispatchAuthority(
        params,
        runtime,
        orchestrationCapability
      )
      const session = requireCollaborationSession(runtime, dispatch)
      const prepare = () =>
        session.prepareCheckpoint({
          taskId: params.taskId,
          nowMs: Date.now(),
          leaseMs: CHECKPOINT_LEASE_MS,
          limit: CHECKPOINT_LIMIT
        })
      let entries = prepare()
      if (!params.wait) {
        return { entries }
      }
      if (entries.length > 0) {
        return checkpointWaitSuccess(entries)
      }

      const deadline = Date.now() + (params.timeoutMs ?? CHECKPOINT_WAIT_DEFAULT_TIMEOUT_MS)
      while (true) {
        const remainingMs = Math.max(0, deadline - Date.now())
        if (remainingMs === 0) {
          return checkpointWaitTimedOut()
        }
        const waitResult = await session.waitForCheckpointAvailability({
          taskId: params.taskId,
          timeoutMs: remainingMs,
          signal
        })
        if (waitResult === 'waiter_exists') {
          throw new OrchestrationError(
            'waiter_exists',
            `Task ${params.taskId} already has an active collaboration checkpoint waiter.`
          )
        }
        if (waitResult === 'timed_out') {
          return checkpointWaitTimedOut()
        }
        if (waitResult === 'cancelled') {
          return {
            entries: [],
            timedOut: false,
            cancelled: true,
            connectionLost: signal?.aborted === true
          }
        }

        const latestDispatch = requireCollaborationDispatchAuthority(
          params,
          runtime,
          orchestrationCapability
        )
        const latestSession = requireCollaborationSession(runtime, latestDispatch)
        if (latestSession !== session) {
          throw new OrchestrationError(
            'collaboration_session_unavailable',
            `Collaboration session for Run ${latestDispatch.run_id} changed while waiting.`
          )
        }
        entries = latestSession.prepareCheckpoint({
          taskId: params.taskId,
          nowMs: Date.now(),
          leaseMs: CHECKPOINT_LEASE_MS,
          limit: CHECKPOINT_LIMIT
        })
        if (entries.length > 0) {
          return checkpointWaitSuccess(entries)
        }
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

function checkpointWaitSuccess(entries: readonly CollaborationPreparedContextEntry[]) {
  return {
    entries,
    timedOut: false,
    cancelled: false,
    connectionLost: false
  }
}

function checkpointWaitTimedOut() {
  return {
    entries: [],
    timedOut: true,
    cancelled: false,
    connectionLost: false
  }
}

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
