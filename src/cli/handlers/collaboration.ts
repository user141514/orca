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
