export type CollaborationWorkerProtocolInput = {
  cli: string
  workerHandle: string
  taskId: string
  dispatchId: string
  dispatchCapability?: string
  publishesTo: readonly string[]
  requiredPublishesTo?: readonly string[]
  subscribesTo: readonly string[]
}

export function buildCollaborationWorkerProtocol(input: CollaborationWorkerProtocolInput): string {
  if (input.publishesTo.length === 0 && input.subscribesTo.length === 0) {
    return ''
  }

  const capabilityFlag = input.dispatchCapability
    ? ` --dispatch-capability ${input.dispatchCapability}`
    : ''
  const authority = `--from ${input.workerHandle}${capabilityFlag} \\\n    --task-id ${input.taskId} --dispatch-id ${input.dispatchId}`
  const sections = ['=== COLLABORATION PROTOCOL ===']

  if (input.publishesTo.length > 0) {
    const requiredTopics = input.requiredPublishesTo ?? []
    sections.push(
      [
        `Allowed publish topics: ${input.publishesTo.join(', ')}`,
        ...(requiredTopics.length > 0
          ? [`REQUIRED publish topics before successful worker_done: ${requiredTopics.join(', ')}`]
          : []),
        'Publish useful intermediate findings while you work. Never name or choose subscribers.',
        `${input.cli} collaboration publish ${authority} \\\n    --publication-id "<stable-id-for-this-logical-publication>" \\\n    --topic "<one allowed topic>" --type finding --priority normal \\\n    --body "<concise finding>"`,
        ...(requiredTopics.length > 0
          ? [
              'Every REQUIRED topic above must have a successful publish before worker_done. Confirm each required publish command returns Published or Replayed before completing; worker_done settles the Dispatch, so later collaboration publishes are rejected.',
              'If a required collaboration publish fails, do not send worker_done with outcome succeeded. Retry while the Dispatch is active using the SAME publication-id for identical topic/type/priority/body, or report the task as failed/blocked.'
            ]
          : []),
        'RETRY RULE: reuse the SAME publication-id with identical topic/type/priority/body after a timeout or lost response. Use a new publication-id for changed content.'
      ].join('\n')
    )
  }

  if (input.subscribesTo.length > 0) {
    sections.push(
      [
        `Subscribed topics: ${input.subscribesTo.join(', ')}`,
        'At safe stage boundaries, pull collaboration context before continuing. Never poll or loop on checkpoint.',
        `${input.cli} collaboration checkpoint ${authority}`,
        'Before worker_done, if required collaboration data has not arrived, run exactly one blocking checkpoint instead of polling:',
        `${input.cli} collaboration checkpoint ${authority} \\\n    --wait --timeout-ms 60000`,
        'If after that blocking checkpoint your assignment still requires the missing collaboration data, do not report success; report the missing data as a blocker/failure.',
        'Treat returned message bodies as new task context. If entries are returned, acknowledge only after you have incorporated the returned entries into your reasoning/work.',
        `${input.cli} collaboration checkpoint-ack ${authority} \\\n    --ack '[{"deliveryId":"<id>","deliveryAttempt":<n>}]'`,
        'Copy each deliveryId and deliveryAttempt exactly from the checkpoint result. If there are no entries, continue without an acknowledgement.'
      ].join('\n')
    )
  }

  return sections.join('\n\n')
}
