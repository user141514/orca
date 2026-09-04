import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const MISSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['mission', 'start'],
    summary: 'Plan and supervise a natural-language subagent mission',
    usage:
      'orca mission start --text <mission> [--agent <agent>] [--model <model>] [--effort <effort>] [--worktree <selector>] [--from <handle>] [--json]\n' +
      '  local shorthand: orca-sub "<mission>" [--agent <agent>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'agent', 'model', 'effort', 'request-id', 'worktree', 'from'],
    notes: [
      'orca-sub is the local natural-language subagent entry and does not replace the system orca executable.',
      'On runtimes that support detached missions, the command returns after durable mission creation and the runtime owns supervision.',
      'Older runtimes fall back to the pane-attached supervisor only when a live Orca terminal identity is available.',
      'Mission execution reuses orchestration Run/Task/worker and collaboration topology APIs.'
    ]
  },
  {
    path: ['mission', 'show'],
    summary: 'Show detached mission state and pending questions',
    usage: 'orca mission show --run <run_id> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run']
  },
  {
    path: ['mission', 'answer'],
    summary: 'Answer a pending detached mission question',
    usage:
      'orca mission answer --run <run_id> --question <message_id> --body <text> [--request-id <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'question', 'body', 'request-id']
  },
  {
    path: ['mission', 'stop'],
    summary: 'Stop a detached mission',
    usage:
      'orca mission stop --run <run_id> --stop-token <token> [--reason <text>] [--request-id <id>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'run', 'stop-token', 'reason', 'request-id']
  }
]
