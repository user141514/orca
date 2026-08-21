import { z } from 'zod'
import { getCommitMessageAgentSpec } from '../../../../shared/commit-message-agent-spec'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { isTuiAgentEnabled, pickTuiAgent } from '../../../../shared/tui-agent-selection'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { CollaborationKernel } from '../../collaboration/collaboration-kernel'
import { MissionCollaborationExecution } from '../../mission/mission-collaboration-execution'
import { buildMissionPlanningPrompt, parseMissionPlan } from '../../mission/mission-plan'
import { defineMethod, type RpcMethod } from '../core'
import { requiredString } from '../schemas'

class MissionError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'MissionError'
  }
}

const MissionStartParams = z.object({
  text: requiredString('Missing mission text'),
  worktree: requiredString('Mission requires an Orca workspace'),
  agent: z
    .custom<TuiAgent>((value) => isTuiAgent(value), { message: 'Invalid mission agent' })
    .optional()
})

export const MISSION_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'mission.start',
    params: MissionStartParams,
    handler: async (params, { runtime }) => {
      const settings = runtime.getClientSettings()
      const preferred = settings.defaultTuiAgent
      const localPreferred = process.env.ORCA_MISSION_DEFAULT_AGENT
      let detected: string[] | undefined
      const getDetectedAgents = async (): Promise<string[]> => {
        if (detected) {
          return detected
        }
        try {
          detected = await detectInstalledAgentsWithShellPathHydration()
        } catch {
          detected = []
        }
        return detected
      }

      let agent = params.agent ?? null
      if (agent && !isTuiAgentEnabled(agent, settings.disabledTuiAgents)) {
        throw new MissionError('agent_unconfigured', `Mission agent ${agent} is disabled in Orca.`)
      }
      if (
        !agent &&
        isTuiAgent(localPreferred) &&
        isTuiAgentEnabled(localPreferred, settings.disabledTuiAgents)
      ) {
        const installed = await getDetectedAgents()
        agent = installed.includes(localPreferred) ? localPreferred : null
      }
      if (!agent) {
        agent =
          isTuiAgent(preferred) && isTuiAgentEnabled(preferred, settings.disabledTuiAgents)
            ? preferred
            : null
      }
      if (!agent && preferred !== 'blank') {
        agent = pickTuiAgent(
          null,
          (await getDetectedAgents()).filter(isTuiAgent),
          settings.disabledTuiAgents
        )
      }
      if (!agent) {
        throw new MissionError(
          'agent_unconfigured',
          'Mission start requires an enabled default or detected agent in Orca.'
        )
      }

      const workspace = await runtime.showManagedTerminalWorkspace(params.worktree)
      const plannerSpec = getCommitMessageAgentSpec(agent)
      let missionPlan: ReturnType<typeof parseMissionPlan> = { mode: 'single-agent' }
      if (plannerSpec) {
        const planning = await runtime.generateRuntimeText(
          `id:${workspace.id}`,
          buildMissionPlanningPrompt(params.text),
          {
            agentId: agent,
            model: plannerSpec.defaultModelId,
            agentCommandOverride: settings.agentCmdOverrides?.[agent]
          },
          'mission-plan',
          { useAgentDefaultModel: true }
        )
        if (!planning.success) {
          throw new MissionError('mission_planner_failed', planning.error)
        }

        try {
          missionPlan = parseMissionPlan(planning.text)
        } catch (error) {
          throw new MissionError(
            'mission_planner_failed',
            error instanceof Error ? error.message : String(error)
          )
        }
      }
      if (missionPlan.mode === 'orchestration') {
        const collaboration = new CollaborationKernel(
          new MissionCollaborationExecution(runtime, workspace.id, agent)
        )
        const { runId } = await collaboration.start({
          objective: missionPlan.objective,
          maxConcurrency: missionPlan.maxConcurrency,
          steps: missionPlan.tasks.map((task) => ({
            key: task.key,
            instruction: task.spec,
            dependsOn: task.deps,
            contextFrom: task.deps
          }))
        })
        return {
          mission: params.text,
          mode: 'orchestration' as const,
          agent,
          runId,
          state: 'running' as const
        }
      }

      const terminal = await runtime.createTerminal(`id:${workspace.id}`, {
        startupAgent: agent,
        title: 'Mission'
      })
      await runtime.focusTerminal(terminal.handle)
      const ready = await runtime.waitForTerminal(terminal.handle, {
        condition: 'tui-idle',
        timeoutMs: 60_000
      })
      if (!ready.satisfied) {
        throw new Error(
          ready.blockedReason ? `Mission agent startup blocked: ${ready.blockedReason}` : 'timeout'
        )
      }
      await runtime.sendTerminalAgentPrompt(terminal.handle, params.text)
      return {
        mission: params.text,
        mode: 'single-agent' as const,
        agent,
        terminal
      }
    }
  })
]
