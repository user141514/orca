import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { RuntimeClientError } from '../runtime-client'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { getBrowserWorktreeSelector } from '../selectors'

export const MISSION_HANDLERS: Record<string, CommandHandler> = {
  'mission start': async ({ flags, client, cwd, json }) => {
    const text = getRequiredStringFlag(flags, 'text')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    if (!worktree) {
      throw new RuntimeClientError(
        'selector_not_found',
        'Mission start requires an Orca-managed workspace. Run it from inside a managed project or pass --worktree.'
      )
    }
    const result = await client.call<{
      mission: string
      mode: 'single-agent'
      agent: string
      terminal: { handle: string }
    }>('mission.start', {
      text,
      worktree,
      ...(getOptionalStringFlag(flags, 'agent')
        ? { agent: getOptionalStringFlag(flags, 'agent') }
        : {})
    })
    printResult(
      result,
      json,
      (value) => `Mission started in ${value.terminal.handle} with ${value.agent}: ${value.mission}`
    )
  }
}
