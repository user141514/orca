import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const MISSION_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['mission', 'start'],
    summary: 'Start a mission in the current Orca workspace',
    usage: 'orca mission start --text <mission> [--agent <agent>] [--worktree <selector>] [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'text', 'agent', 'worktree'],
    notes: [
      'The root shorthand `orca "<mission>"` routes here for natural-language mission text and accepts --agent.',
      "Without --agent, Mission follows Orca's configured/default agent selection; orchestration planning is layered behind this same entry point later."
    ]
  }
]
