import type { CommandHandler } from '../dispatch'
import { getRequiredStringFlag } from '../flags'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'

type CollaborationMessage = {
  id: string
  topic: string
  type: string
  priority: 'normal' | 'high' | 'urgent'
  producerKey: string
  body: string
}

type CollaborationPublishResult = {
  messageId: string
  deliveryIds: string[]
  replayed: boolean
}

type CollaborationCheckpointResult = {
  entries: {
    deliveryId: string
    deliveryAttempt: number
    message: CollaborationMessage
  }[]
}

type CollaborationCheckpointAckResult = {
  ackedDeliveryIds: string[]
  ignoredDeliveryIds: string[]
}

type CollaborationAcknowledgement = {
  deliveryId: string
  deliveryAttempt: number
}

export const COLLABORATION_HANDLERS: Record<string, CommandHandler> = {
  'collaboration publish': async ({ flags, client, json }) => {
    const authority = readAuthorityFlags(flags)
    const response = await client.call<CollaborationPublishResult>(
      'collaboration.publish',
      {
        ...authority.params,
        publicationId: getRequiredStringFlag(flags, 'publication-id'),
        topic: getRequiredStringFlag(flags, 'topic'),
        type: getRequiredStringFlag(flags, 'type'),
        priority: readPriorityFlag(flags),
        body: getRequiredStringFlag(flags, 'body')
      },
      { orchestrationCapability: authority.dispatchCapability }
    )
    printResult(response, json, formatPublish)
  },
  'collaboration checkpoint': async ({ flags, client, json }) => {
    const authority = readAuthorityFlags(flags)
    const response = await client.call<CollaborationCheckpointResult>(
      'collaboration.checkpoint',
      authority.params,
      { orchestrationCapability: authority.dispatchCapability }
    )
    printResult(response, json, formatCheckpoint)
  },
  'collaboration checkpoint-ack': async ({ flags, client, json }) => {
    const authority = readAuthorityFlags(flags)
    const acknowledgements = parseAcknowledgements(getRequiredStringFlag(flags, 'ack'))
    const response = await client.call<CollaborationCheckpointAckResult>(
      'collaboration.checkpoint-ack',
      { ...authority.params, acknowledgements },
      { orchestrationCapability: authority.dispatchCapability }
    )
    printResult(response, json, formatCheckpointAck)
  }
}

function readAuthorityFlags(flags: Map<string, string | boolean>): {
  params: { from: string; taskId: string; dispatchId: string }
  dispatchCapability: string
} {
  return {
    params: {
      from: getRequiredStringFlag(flags, 'from'),
      taskId: getRequiredStringFlag(flags, 'task-id'),
      dispatchId: getRequiredStringFlag(flags, 'dispatch-id')
    },
    dispatchCapability: getRequiredStringFlag(flags, 'dispatch-capability')
  }
}

function readPriorityFlag(flags: Map<string, string | boolean>): CollaborationMessage['priority'] {
  const priority = getRequiredStringFlag(flags, 'priority')
  if (priority !== 'normal' && priority !== 'high' && priority !== 'urgent') {
    throw new RuntimeClientError('invalid_argument', '--priority must be normal, high, or urgent')
  }
  return priority
}

function parseAcknowledgements(raw: string): CollaborationAcknowledgement[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RuntimeClientError('invalid_argument', '--ack must be valid JSON')
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 50 ||
    !parsed.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as Record<string, unknown>).deliveryId === 'string' &&
        ((entry as Record<string, unknown>).deliveryId as string).length > 0 &&
        Number.isInteger((entry as Record<string, unknown>).deliveryAttempt) &&
        ((entry as Record<string, unknown>).deliveryAttempt as number) >= 1
    )
  ) {
    throw new RuntimeClientError(
      'invalid_argument',
      '--ack must be a JSON array of {deliveryId,deliveryAttempt}'
    )
  }
  return parsed as CollaborationAcknowledgement[]
}

function formatPublish(result: CollaborationPublishResult): string {
  const verb = result.replayed ? 'Replayed' : 'Published'
  const count = result.deliveryIds.length
  if (count === 0) {
    return `${verb} ${result.messageId} to 0 subscribers.`
  }
  const noun = count === 1 ? 'subscriber' : 'subscribers'
  return `${verb} ${result.messageId} to ${count} ${noun}: ${result.deliveryIds.join(', ')}`
}

function formatCheckpoint(result: CollaborationCheckpointResult): string {
  if (result.entries.length === 0) {
    return 'No checkpoint entries.'
  }
  return result.entries
    .map((entry) =>
      [
        `delivery ${entry.deliveryId} attempt=${entry.deliveryAttempt}`,
        `${entry.message.topic} ${entry.message.type} ${entry.message.priority} producer=${entry.message.producerKey}`,
        escapeControlCharacters(entry.message.body)
      ].join('\n')
    )
    .join('\n\n')
}

function formatCheckpointAck(result: CollaborationCheckpointAckResult): string {
  const lines = [
    `Acknowledged ${result.ackedDeliveryIds.length}${
      result.ackedDeliveryIds.length > 0 ? `: ${result.ackedDeliveryIds.join(', ')}` : ''
    }`
  ]
  if (result.ignoredDeliveryIds.length > 0) {
    lines.push(
      `Ignored ${result.ignoredDeliveryIds.length}: ${result.ignoredDeliveryIds.join(', ')}`
    )
  }
  return lines.join('\n')
}

function escapeControlCharacters(value: string): string {
  return [...value]
    .map((character) => {
      const code = character.charCodeAt(0)
      if (character === '\n' || (code >= 0x20 && code < 0x7f) || code > 0x9f) {
        return character
      }
      return `\\x${code.toString(16).padStart(2, '0')}`
    })
    .join('')
}
