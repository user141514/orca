import type { CollaborationAdmissionPolicy } from './collaboration-admission'
import {
  prepareCollaborationCheckpoint,
  type CollaborationPreparedContextEntry
} from './collaboration-checkpoint-delivery'
import type { CollaborationDelivery } from './collaboration-mailbox'
import { CollaborationMailbox } from './collaboration-mailbox'
import type { CollaborationMessage } from './collaboration-message'
import { routeCollaborationMessage } from './collaboration-message'
import { buildCollaborationRoutingTable } from './collaboration-routing'
import type { CollaborationPlan } from './types'

export type CollaborationDeliveryIdFactory = (input: {
  subscriberKey: string
  message: CollaborationMessage
}) => string

export class CollaborationPublishTopicError extends Error {
  constructor(
    readonly stepKey: string,
    readonly topic: string
  ) {
    super(`Step ${stepKey} is not allowed to publish to topic: ${topic}`)
    this.name = 'CollaborationPublishTopicError'
  }
}

export class CollaborationPublicationConflictError extends Error {
  constructor(readonly publicationId: string) {
    super(`Collaboration publication id reused with different content: ${publicationId}`)
    this.name = 'CollaborationPublicationConflictError'
  }
}

type CollaborationPublicationReceipt = {
  message: CollaborationMessage
  deliveryIds: readonly string[]
}

export type CollaborationCheckpointWaitResult =
  | 'notified'
  | 'timed_out'
  | 'cancelled'
  | 'waiter_exists'

type CollaborationCheckpointWaiter = {
  notify: () => void
}

export class CollaborationRuntimeSession {
  private readonly mailbox = new CollaborationMailbox()
  private readonly routing
  private readonly stepKeyByTaskId = new Map<string, string>()
  private readonly admissionByStepKey = new Map<string, CollaborationAdmissionPolicy>()
  private readonly publishesToByStepKey = new Map<string, ReadonlySet<string>>()
  private readonly publicationsByStepKey = new Map<
    string,
    Map<string, CollaborationPublicationReceipt>
  >()
  private readonly checkpointWaiterByStepKey = new Map<string, CollaborationCheckpointWaiter>()

  constructor(options: {
    plan: CollaborationPlan
    taskIdsByStepKey: Readonly<Record<string, string>>
    admissionByStepKey: Readonly<Record<string, CollaborationAdmissionPolicy>>
  }) {
    this.routing = buildCollaborationRoutingTable(options.plan)
    const planStepKeys = new Set(options.plan.steps.map((step) => step.key))
    for (const step of options.plan.steps) {
      if ((step.publishesTo?.length ?? 0) > 0) {
        this.publishesToByStepKey.set(step.key, new Set(step.publishesTo))
      }
      const hasPolicy = Object.hasOwn(options.admissionByStepKey, step.key)
      const policy = hasPolicy ? options.admissionByStepKey[step.key] : undefined
      if ((step.subscribesTo?.length ?? 0) > 0 && !policy) {
        throw new Error(`Missing collaboration admission policy for step: ${step.key}`)
      }
      if (policy) {
        this.admissionByStepKey.set(step.key, policy)
      }
    }
    for (const [stepKey, taskId] of Object.entries(options.taskIdsByStepKey)) {
      if (!planStepKeys.has(stepKey)) {
        throw new Error(`Unknown collaboration step key in task mapping: ${stepKey}`)
      }
      if (this.stepKeyByTaskId.has(taskId)) {
        throw new Error(`Duplicate collaboration task id: ${taskId}`)
      }
      this.stepKeyByTaskId.set(taskId, stepKey)
    }
  }

  publishFromTask(options: {
    taskId: string
    message: Omit<CollaborationMessage, 'producerKey'>
    deliveryIdFor: CollaborationDeliveryIdFactory
  }): { deliveryIds: readonly string[]; replayed: boolean } {
    const stepKey = this.stepKeyByTaskId.get(options.taskId)
    if (!stepKey) {
      throw new Error(`Unknown collaboration task: ${options.taskId}`)
    }
    const publishedTopics = this.publishesToByStepKey.get(stepKey)
    if (!publishedTopics?.has(options.message.topic)) {
      throw new CollaborationPublishTopicError(stepKey, options.message.topic)
    }
    const message: CollaborationMessage = { ...options.message, producerKey: stepKey }
    const publications = this.publicationsByStepKey.get(stepKey) ?? new Map()
    const existing = publications.get(message.id)
    if (existing) {
      if (!sameCollaborationMessage(existing.message, message)) {
        throw new CollaborationPublicationConflictError(message.id)
      }
      return { deliveryIds: [...existing.deliveryIds], replayed: true }
    }

    const deliveryIds = this.publish(message, options.deliveryIdFor)
    publications.set(message.id, { message, deliveryIds: [...deliveryIds] })
    this.publicationsByStepKey.set(stepKey, publications)
    return { deliveryIds: [...deliveryIds], replayed: false }
  }

  publish(message: CollaborationMessage, deliveryIdFor: CollaborationDeliveryIdFactory): string[] {
    const resolved = routeCollaborationMessage(this.routing, message).map((intent) => ({
      intent,
      deliveryId: deliveryIdFor({ subscriberKey: intent.subscriberKey, message })
    }))
    const seen = new Set<string>()
    for (const { deliveryId } of resolved) {
      if (seen.has(deliveryId) || this.mailbox.get(deliveryId)) {
        throw new Error(`Duplicate collaboration delivery id: ${deliveryId}`)
      }
      seen.add(deliveryId)
    }
    for (const { deliveryId, intent } of resolved) {
      this.mailbox.enqueue(deliveryId, intent)
    }
    for (const { intent } of resolved) {
      this.checkpointWaiterByStepKey.get(intent.subscriberKey)?.notify()
    }
    return resolved.map(({ deliveryId }) => deliveryId)
  }

  waitForCheckpointAvailability(options: {
    taskId: string
    timeoutMs: number
    signal?: AbortSignal
  }): Promise<CollaborationCheckpointWaitResult> {
    const { stepKey } = this.requireCheckpointBinding(options.taskId)
    if (this.checkpointWaiterByStepKey.has(stepKey)) {
      return Promise.resolve('waiter_exists')
    }
    if (options.signal?.aborted) {
      return Promise.resolve('cancelled')
    }

    return new Promise((resolve) => {
      let settled = false
      let timeout: ReturnType<typeof setTimeout> | null = null
      let abortCleanup: (() => void) | null = null
      const finish = (result: CollaborationCheckpointWaitResult): void => {
        if (settled) {
          return
        }
        settled = true
        if (timeout) {
          clearTimeout(timeout)
          timeout = null
        }
        abortCleanup?.()
        abortCleanup = null
        if (this.checkpointWaiterByStepKey.get(stepKey) === waiter) {
          this.checkpointWaiterByStepKey.delete(stepKey)
        }
        resolve(result)
      }
      const waiter: CollaborationCheckpointWaiter = {
        notify: () => finish('notified')
      }
      const signal = options.signal
      if (signal) {
        const onAbort = (): void => finish('cancelled')
        signal.addEventListener('abort', onAbort, { once: true })
        abortCleanup = () => signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          finish('cancelled')
          return
        }
      }

      this.checkpointWaiterByStepKey.set(stepKey, waiter)
      if (this.hasCheckpointAvailability(stepKey)) {
        finish('notified')
        return
      }
      timeout = setTimeout(() => finish('timed_out'), Math.max(0, options.timeoutMs))
    })
  }

  prepareCheckpoint(options: {
    taskId: string
    nowMs: number
    leaseMs: number
    limit: number
  }): readonly CollaborationPreparedContextEntry[] {
    const { stepKey, policy } = this.requireCheckpointBinding(options.taskId)
    return prepareCollaborationCheckpoint({
      mailbox: this.mailbox,
      subscriberKey: stepKey,
      nowMs: options.nowMs,
      leaseMs: options.leaseMs,
      limit: options.limit,
      policy
    })
  }

  acknowledgeCheckpoint(options: {
    taskId: string
    nowMs: number
    acknowledgements: readonly { deliveryId: string; deliveryAttempt: number }[]
  }): { ackedDeliveryIds: string[]; ignoredDeliveryIds: string[] } {
    const { stepKey } = this.requireCheckpointBinding(options.taskId)
    this.mailbox.releaseExpired(options.nowMs)
    for (const acknowledgement of options.acknowledgements) {
      const delivery = this.mailbox.get(acknowledgement.deliveryId)
      if (delivery && delivery.subscriberKey !== stepKey) {
        throw new Error(
          `Collaboration delivery ${acknowledgement.deliveryId} does not belong to task ${options.taskId}`
        )
      }
    }

    const ackedDeliveryIds: string[] = []
    const ignoredDeliveryIds: string[] = []
    for (const acknowledgement of options.acknowledgements) {
      const acked = this.mailbox.ack(acknowledgement.deliveryId, acknowledgement.deliveryAttempt)
      ;(acked ? ackedDeliveryIds : ignoredDeliveryIds).push(acknowledgement.deliveryId)
    }
    return { ackedDeliveryIds, ignoredDeliveryIds }
  }

  getDelivery(deliveryId: string): CollaborationDelivery | undefined {
    return this.mailbox.get(deliveryId)
  }

  private hasCheckpointAvailability(stepKey: string): boolean {
    return this.mailbox.pending(stepKey).length > 0 || this.mailbox.inFlight(stepKey).length > 0
  }

  private requireCheckpointBinding(taskId: string): {
    stepKey: string
    policy: CollaborationAdmissionPolicy
  } {
    const stepKey = this.stepKeyByTaskId.get(taskId)
    if (!stepKey) {
      throw new Error(`Unknown collaboration task: ${taskId}`)
    }
    const policy = this.admissionByStepKey.get(stepKey)
    if (!policy) {
      throw new Error(`Missing collaboration admission policy for step: ${stepKey}`)
    }
    return { stepKey, policy }
  }
}

function sameCollaborationMessage(
  left: CollaborationMessage,
  right: CollaborationMessage
): boolean {
  return (
    left.id === right.id &&
    left.topic === right.topic &&
    left.type === right.type &&
    left.priority === right.priority &&
    left.producerKey === right.producerKey &&
    left.body === right.body
  )
}
