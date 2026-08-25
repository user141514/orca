import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AUTHORITY_FLAGS = ['from', 'task-id', 'dispatch-id', 'dispatch-capability']

export const COLLABORATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['collaboration', 'publish'],
    summary: 'Publish one collaboration message from the authenticated worker task',
    usage:
      'orca collaboration publish --from <handle> --task-id <task> --dispatch-id <dispatch> --dispatch-capability <cap> --publication-id <id> --topic <topic> --type <type> --priority <normal|high|urgent> --body <text> [--json]',
    allowedFlags: [
      ...GLOBAL_FLAGS,
      ...AUTHORITY_FLAGS,
      'publication-id',
      'topic',
      'type',
      'priority',
      'body'
    ]
  },
  {
    path: ['collaboration', 'checkpoint'],
    summary: 'Read collaboration context waiting at an explicit worker checkpoint',
    usage:
      'orca collaboration checkpoint --from <handle> --task-id <task> --dispatch-id <dispatch> --dispatch-capability <cap> [--wait] [--timeout-ms <ms>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...AUTHORITY_FLAGS, 'wait', 'timeout-ms'],
    notes: [
      'Without --wait, checkpoint is a non-blocking snapshot. With --wait, it waits event-driven for admitted collaboration context or timeout; it does not poll.'
    ]
  },
  {
    path: ['collaboration', 'checkpoint-ack'],
    summary: 'Acknowledge collaboration context consumed by the worker',
    usage:
      "orca collaboration checkpoint-ack --from <handle> --task-id <task> --dispatch-id <dispatch> --dispatch-capability <cap> --ack '<json_array>' [--json]",
    allowedFlags: [...GLOBAL_FLAGS, ...AUTHORITY_FLAGS, 'ack']
  }
]
