import { createHash } from 'node:crypto'
import type { CollaborationPreparedContextEntry } from '../collaboration/collaboration-checkpoint-delivery'
import type { OrcaRuntimeService } from '../orca-runtime'
import { getCollaborationRuntimeSession } from './collaboration-runtime-registry'

const TOOL_CHECKPOINT_LEASE_MS = 60_000
const TOOL_CHECKPOINT_LIMIT = 50

type CollaborationToolCheckpointIdentity = {
  paneKey: string
  launchToken: string
  nowMs: number
}

export class CollaborationToolCheckpointService {
  constructor(private readonly runtime: OrcaRuntimeService) {}

  prepare(input: CollaborationToolCheckpointIdentity): {
    active: boolean
    entries: readonly CollaborationPreparedContextEntry[]
  } {
    const binding = this.resolveBinding(input)
    if (!binding) {
      return { active: false, entries: [] }
    }
    return {
      active: true,
      entries: binding.session.prepareCheckpoint({
        taskId: binding.taskId,
        nowMs: input.nowMs,
        leaseMs: TOOL_CHECKPOINT_LEASE_MS,
        limit: TOOL_CHECKPOINT_LIMIT
      })
    }
  }

  acknowledge(
    input: CollaborationToolCheckpointIdentity & {
      acknowledgements: readonly { deliveryId: string; deliveryAttempt: number }[]
    }
  ): {
    active: boolean
    ackedDeliveryIds: string[]
    ignoredDeliveryIds: string[]
  } {
    const binding = this.resolveBinding(input)
    if (!binding) {
      return {
        active: false,
        ackedDeliveryIds: [],
        ignoredDeliveryIds: input.acknowledgements.map(({ deliveryId }) => deliveryId)
      }
    }
    return {
      active: true,
      ...binding.session.acknowledgeCheckpoint({
        taskId: binding.taskId,
        nowMs: input.nowMs,
        acknowledgements: input.acknowledgements
      })
    }
  }

  private resolveBinding(input: CollaborationToolCheckpointIdentity) {
    if (!input.paneKey || !input.launchToken) {
      return undefined
    }
    const db = this.runtime.getOrchestrationDb()
    const dispatch = db.getActiveDispatchForIdentity('', input.paneKey)
    if (!dispatch?.launch_token_hash || !dispatch.assignee_handle) {
      return undefined
    }
    const launchTokenHash = createHash('sha256').update(input.launchToken).digest('hex')
    if (launchTokenHash !== dispatch.launch_token_hash) {
      return undefined
    }
    const liveAuthority = this.runtime.getOrchestrationDispatchAuthority(dispatch.assignee_handle)
    if (
      !liveAuthority?.paneKey ||
      liveAuthority.paneKey !== input.paneKey ||
      liveAuthority.launchTokenHash !== launchTokenHash ||
      !dispatch.process_incarnation ||
      liveAuthority.processIncarnation !== dispatch.process_incarnation
    ) {
      return undefined
    }
    const session = getCollaborationRuntimeSession(this.runtime, dispatch.run_id)
    return session ? { session, taskId: dispatch.task_id } : undefined
  }
}
