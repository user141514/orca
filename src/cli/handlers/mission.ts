import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import { getOptionalStringFlag, getRequiredStringFlag } from '../flags'
import { RuntimeClientError, type RuntimeClient } from '../runtime-client'
import { withOrcaCliLock } from '../runtime/orca-host-start-lock'
import { getBrowserWorktreeSelector } from '../selectors'
import {
  executeMissionRun,
  type MissionPlanRpcResult,
  type MissionTask
} from './mission/mission-supervisor'
import { resolveCoordinatorTerminalHandle } from './orchestration/terminal-identity'

const MISSION_RUNTIME_START_TIMEOUT_MS = 60_000

export const MISSION_HANDLERS: Record<string, CommandHandler> = {
  'mission start': async ({ flags, client, cwd, json }) => {
    const mission = getRequiredStringFlag(flags, 'text')
    await client.ensureOrca(MISSION_RUNTIME_START_TIMEOUT_MS)
    const workspace = await resolveMissionWorkspace(flags, cwd, client)
    const coordinator = await resolveMissionCoordinator(flags, cwd, client, workspace)
    try {
      const planned = await client.call<MissionPlanRpcResult>('mission.plan', {
        text: mission,
        worktree: workspace.worktree,
        agent: getOptionalStringFlag(flags, 'agent')
      })
      const plan = planned.result.plan
      const objective = plan.mode === 'orchestration' ? plan.objective : mission
      const maxConcurrency = plan.mode === 'orchestration' ? plan.maxConcurrency : 1
      const tasks =
        plan.mode === 'orchestration'
          ? plan.tasks
          : [{ key: 'mission', spec: mission, deps: [] } satisfies MissionTask]

      const runResponse = await client.call<{ run: { id: string; objective: string } }>(
        'orchestration.runCreate',
        { objective, from: coordinator.handle }
      )
      const summary = await executeMissionRun({
        client,
        mission,
        runId: runResponse.result.run.id,
        from: coordinator.handle,
        worktree: workspace.worktree,
        agent: planned.result.agent,
        agentCandidates: planned.result.agentCandidates,
        tasks,
        maxConcurrency
      })

      if (summary.state === 'failed') {
        process.exitCode = 1
      }
      printResult(
        { ...runResponse, result: summary },
        json,
        (value) =>
          `Mission run ${value.runId} ${value.state}: ${value.completedTasks} completed, ${value.failedTasks} failed.`
      )
    } finally {
      if (coordinator.temporary) {
        await client.call('terminal.close', { terminal: coordinator.handle }).catch(() => undefined)
      }
    }
  }
}

async function resolveMissionWorkspace(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient
): Promise<{ worktree: string; scratch: boolean }> {
  const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
  if (worktree) {
    return { worktree, scratch: false }
  }
  if (client.isRemote) {
    throw new RuntimeClientError(
      'selector_not_found',
      'Remote Mission requires an explicit Orca workspace.'
    )
  }

  const scratchRoot = process.env.ORCA_MISSION_SCRATCH_ROOT?.trim() || join(homedir(), '.orca', 'mission-scratch')
  await mkdir(scratchRoot, { recursive: true })
  const group = await withOrcaCliLock(async () => {
    const groups = await client.call<{
      groups: { id: string; name: string; parentPath?: string | null }[]
    }>('projectGroup.list')
    const matchingGroups = groups.result.groups.filter((candidate) =>
      samePath(candidate.parentPath, scratchRoot)
    )
    if (matchingGroups.length > 1) {
      throw new RuntimeClientError(
        'mission_scratch_ambiguous',
        `Multiple Mission scratch project groups target ${scratchRoot}.`
      )
    }
    return (
      matchingGroups[0] ??
      (
        await client.call<{ group: { id: string } }>('projectGroup.create', {
          name: 'Mission Scratch',
          parentPath: scratchRoot,
          createdFrom: 'manual'
        })
      ).result.group
    )
  }, { lockHome: scratchRoot, lockName: 'project-group.lock' })
  const runId = randomUUID()
  const runPath = join(scratchRoot, 'runs', runId)
  await mkdir(runPath, { recursive: true })
  const created = await client.call<{ folderWorkspace: { id: string } }>('folderWorkspace.create', {
    projectGroupId: group.id,
    name: `Mission ${runId.slice(0, 8)}`,
    folderPath: runPath
  })
  return { worktree: `folder:${created.result.folderWorkspace.id}`, scratch: true }
}

async function resolveMissionCoordinator(
  flags: Map<string, string | boolean>,
  cwd: string,
  client: RuntimeClient,
  workspace: { worktree: string; scratch: boolean }
): Promise<{ handle: string; temporary: boolean }> {
  if (!workspace.scratch) {
    try {
      return {
        handle: await resolveCoordinatorTerminalHandle(flags, cwd, client),
        temporary: false
      }
    } catch (error) {
      if (!(error instanceof RuntimeClientError) || error.code !== 'no_active_sender_terminal') {
        throw error
      }
    }
  }

  const created = await client.call<{ terminal: { handle: string } }>('terminal.create', {
    worktree: workspace.worktree,
    title: 'Mission coordinator',
    focus: false,
    presentation: 'background'
  })
  return { handle: created.result.terminal.handle, temporary: true }
}

function samePath(left: string | null | undefined, right: string): boolean {
  if (!left) {
    return false
  }
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}
