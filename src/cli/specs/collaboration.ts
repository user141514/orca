import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

const AUTHORITY_FLAGS = ['from', 'task-id', 'dispatch-id', 'dispatch-capability']

export const COLLABORATION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['collaboration', 'checkpoint'],
    summary: 'Read collaboration context waiting at an explicit worker checkpoint',
    usage:
      'orca collaboration checkpoint --from <handle> --task-id <task> --dispatch-id <dispatch> --dispatch-capability <cap> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, ...AUTHORITY_FLAGS]
  },
  {
    path: ['collaboration', 'checkpoint-ack'],
    summary: 'Acknowledge collaboration context consumed by the worker',
    usage:
      "orca collaboration checkpoint-ack --from <handle> --task-id <task> --dispatch-id <dispatch> --dispatch-capability <cap> --ack '<json_array>' [--json]",
    allowedFlags: [...GLOBAL_FLAGS, ...AUTHORITY_FLAGS, 'ack']
  }
]
