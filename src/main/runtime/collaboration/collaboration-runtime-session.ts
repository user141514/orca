import type {
  CollaborationAdmissionContextEntry,
  CollaborationAdmissionPolicy
} from './collaboration-admission'
import { deliverCollaborationCheckpoint } from './collaboration-checkpoint-delivery'
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

export class CollaborationRuntimeSession {
  private readonly mailbox = new CollaborationMailbox()
  private readonly routing
  private readonly stepKeyByTaskId = new Map<string, string>()
  private readonly admissionByStepKey = new Map<string, CollaborationAdmissionPolicy>()

  constructor(options: {
    plan: CollaborationPlan
    taskIdsByStepKey: Readonly<Record<string, string>>
    admissionByStepKey: Readonly<Record<string, CollaborationAdmissionPolicy>>
  }) {
    this.routing = buildCollaborationRoutingTable(options.plan)
    const planStepKeys = new Set(options.plan.steps.map((step) => step.key))
    for (const step of options.plan.steps) {
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
    return resolved.map(({ deliveryId }) => deliveryId)
  }

  async checkpoint(options: {
    taskId: string
    nowMs: number
    leaseMs: number
    limit: number
    commitContext: (entries: readonly CollaborationAdmissionContextEntry[]) => Promise<void>
  }): Promise<void> {
    const stepKey = this.stepKeyByTaskId.get(options.taskId)
    if (!stepKey) {
      throw new Error(`Unknown collaboration task: ${options.taskId}`)
    }
    const policy = this.admissionByStepKey.get(stepKey)
    if (!policy) {
      throw new Error(`Missing collaboration admission policy for step: ${stepKey}`)
    }
    await deliverCollaborationCheckpoint({
      mailbox: this.mailbox,
      subscriberKey: stepKey,
      nowMs: options.nowMs,
      leaseMs: options.leaseMs,
      limit: options.limit,
      policy,
      commitContext: options.commitContext
    })
  }

  releaseExpired(nowMs: number): CollaborationDelivery[] {
    return this.mailbox.releaseExpired(nowMs)
  }

  getDelivery(deliveryId: string): CollaborationDelivery | undefined {
    return this.mailbox.get(deliveryId)
  }
}
