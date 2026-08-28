import { homedir } from 'node:os'
import { z } from 'zod'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  isTuiAgentEnabled,
  TUI_AGENT_AUTO_PICK_ORDER
} from '../../../../shared/tui-agent-selection'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'
import { SOURCE_CONTROL_GENERATION_TIMEOUT_MS } from '../../../text-generation/source-control-generation-limits'
import type { OrcaRuntimeService } from '../../orca-runtime'
import {
  buildMissionPlanRepairPrompt,
  buildMissionPlanningPrompt,
  parseMissionPlan
} from '../../mission/mission-plan'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

const MissionPlanParams = z.object({
  text: requiredString('Missing mission text'),
  worktree: requiredString('Mission requires an Orca workspace'),
  agent: z
    .custom<TuiAgent>((value) => isTuiAgent(value), { message: 'Invalid mission agent' })
    .optional()
})

const MISSION_PLANNING_TOTAL_TIMEOUT_MS = SOURCE_CONTROL_GENERATION_TIMEOUT_MS * 2

export const MISSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'mission.plan',
    params: MissionPlanParams,
    handler: async (params, { runtime, signal }) => {
      const settings = runtime.getClientSettings()
      const agents = await resolveMissionAgents(params.agent, settings)

      try {
        await runtime.showManagedTerminalWorkspace(params.worktree)
      } catch {
        throw new OrchestrationError(
          'selector_not_found',
          'Mission requires an Orca-managed workspace.'
        )
      }

      throwIfMissionPlanningAborted(signal)

      let lastPlannerError: OrchestrationError | null = null
      const planningStartedAt = Date.now()
      for (const [index, agent] of agents.entries()) {
        throwIfMissionPlanningAborted(signal)
        if (!canStartMissionPlanningAttempt(planningStartedAt)) {
          break
        }
        try {
          const planned = await planMissionWithAgent(
            params.text,
            agent,
            settings,
            planningStartedAt,
            signal
          )
          throwIfMissionPlanningAborted(signal)
          return { ...planned, agentCandidates: agents.slice(index) }
        } catch (error) {
          throwIfMissionPlanningAborted(signal)
          if (
            params.agent ||
            !(error instanceof OrchestrationError) ||
            error.code !== 'mission_planner_failed'
          ) {
            throw error
          }
          lastPlannerError = error
        }
      }

      throwIfMissionPlanningAborted(signal)

      throw new OrchestrationError(
        'mission_planner_failed',
        `Mission planner failed for all available agents (${agents.join(', ')}): ${lastPlannerError?.message ?? 'unknown planner failure'}`
      )
    }
  })
]

async function planMissionWithAgent(
  mission: string,
  agent: TuiAgent,
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>,
  planningStartedAt: number,
  signal?: AbortSignal
) {
  const plannerSpec = getCommitMessageAgentSpec(agent)
  if (!plannerSpec) {
    return { mission, agent, plan: { mode: 'single-agent' as const } }
  }

  const generationParams = {
    agentId: agent,
    model: plannerSpec.defaultModelId,
    agentCommandOverride: settings.agentCmdOverrides?.[agent]
  }
  const generationTarget = { kind: 'local' as const, cwd: homedir() }
  const generationOptions = { useAgentDefaultModel: true, signal } as const
  let planning: Awaited<ReturnType<typeof generateTextFromPrompt>>
  try {
    planning = await generateTextFromPrompt(
      buildMissionPlanningPrompt(mission),
      generationParams,
      generationTarget,
      'mission-plan',
      generationOptions
    )
  } catch (error) {
    throwIfMissionPlanningAborted(signal)
    throw error
  }
  throwIfMissionPlanningAborted(signal)
  if (!planning.success) {
    if (planning.canceled) {
      throwMissionPlanningAborted()
    }
    throw new OrchestrationError('mission_planner_failed', planning.error)
  }

  let plan: ReturnType<typeof parseMissionPlan>
  try {
    plan = parseMissionPlan(planning.text)
  } catch (error) {
    const validationError = error instanceof Error ? error.message : String(error)
    throwIfMissionPlanningAborted(signal)
    if (!canStartMissionPlanningAttempt(planningStartedAt)) {
      throw new OrchestrationError(
        'mission_planner_failed',
        'Mission planner did not have enough time remaining for a repair attempt.'
      )
    }
    let repaired: Awaited<ReturnType<typeof generateTextFromPrompt>>
    try {
      repaired = await generateTextFromPrompt(
        buildMissionPlanRepairPrompt(mission, planning.text, validationError),
        generationParams,
        generationTarget,
        'mission-plan',
        generationOptions
      )
    } catch (repairError) {
      throwIfMissionPlanningAborted(signal)
      throw repairError
    }
    throwIfMissionPlanningAborted(signal)
    if (!repaired.success) {
      if (repaired.canceled) {
        throwMissionPlanningAborted()
      }
      throw new OrchestrationError('mission_planner_failed', repaired.error)
    }
    let repairedPlan: ReturnType<typeof parseMissionPlan>
    try {
      repairedPlan = parseMissionPlan(repaired.text)
    } catch (repairError) {
      throwIfMissionPlanningAborted(signal)
      throw new OrchestrationError(
        'mission_planner_failed',
        repairError instanceof Error ? repairError.message : String(repairError)
      )
    }
    throwIfMissionPlanningAborted(signal)
    return { mission, agent, plan: repairedPlan }
  }
  throwIfMissionPlanningAborted(signal)
  return { mission, agent, plan }
}

function canStartMissionPlanningAttempt(planningStartedAt: number): boolean {
  return (
    Date.now() - planningStartedAt + SOURCE_CONTROL_GENERATION_TIMEOUT_MS <=
    MISSION_PLANNING_TOTAL_TIMEOUT_MS
  )
}

function throwIfMissionPlanningAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throwMissionPlanningAborted()
  }
}

function throwMissionPlanningAborted(): never {
  throw new OrchestrationError('request_aborted', 'Mission planning was cancelled.')
}

async function resolveMissionAgents(
  requested: TuiAgent | undefined,
  settings: ReturnType<OrcaRuntimeService['getClientSettings']>
): Promise<TuiAgent[]> {
  if (requested) {
    if (!isTuiAgentEnabled(requested, settings.disabledTuiAgents)) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Mission agent ${requested} is disabled in Orca.`
      )
    }
    return [requested]
  }

  const candidates: TuiAgent[] = []
  const addCandidate = (value: unknown): void => {
    if (
      isTuiAgent(value) &&
      isTuiAgentEnabled(value, settings.disabledTuiAgents) &&
      !candidates.includes(value)
    ) {
      candidates.push(value)
    }
  }

  addCandidate(process.env.ORCA_MISSION_DEFAULT_AGENT)
  addCandidate(settings.defaultTuiAgent)

  const detected = new Set((await detectMissionAgents()).filter(isTuiAgent))
  for (const agent of TUI_AGENT_AUTO_PICK_ORDER) {
    if (detected.has(agent)) {
      addCandidate(agent)
    }
  }

  if (candidates.length === 0) {
    throw new OrchestrationError(
      'agent_unconfigured',
      'Mission requires an enabled default or detected agent in Orca.'
    )
  }
  return candidates
}

async function detectMissionAgents(): Promise<string[]> {
  try {
    return await detectInstalledAgentsWithShellPathHydration()
  } catch {
    return []
  }
}
