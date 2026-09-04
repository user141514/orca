import type { CommandHandler } from '../dispatch'
import { printResult } from '../format'
import {
  getOptionalStringFlag,
  getRequiredStringFlag,
  getRequiredStringFlagAllowingEmpty
} from '../flags'
import { RuntimeClientError } from '../runtime-client'
import { getBrowserWorktreeSelector } from '../selectors'
import {
  executeMissionRun,
  type MissionPlanRpcResult,
  type MissionTask
} from './mission/mission-supervisor'
import { resolveCoordinatorTerminalHandle } from './orchestration/terminal-identity'

export const MISSION_HANDLERS: Record<string, CommandHandler> = {
  'mission show': async ({ flags, client, json }) => {
    const result = await client.call<{
      runId: string
      lifecycle: string
      counts: Record<string, number>
      questions: unknown[]
      lastError: string | null
    }>('mission.show', {
      runId: getRequiredStringFlag(flags, 'run')
    })
    printResult(
      result,
      json,
      (value) =>
        `Mission run ${value.runId} ${value.lifecycle}: ${value.counts.completed ?? 0}/${value.counts.total ?? 0} completed, ${value.questions.length} pending question(s).`
    )
  },
  'mission answer': async ({ flags, client, json }) => {
    const result = await client.call<{ runId: string; accepted: boolean }>(
      'mission.answer',
      {
        runId: getRequiredStringFlag(flags, 'run'),
        questionId: getRequiredStringFlag(flags, 'question'),
        body: getRequiredStringFlagAllowingEmpty(flags, 'body')
      },
      { orchestrationRequestId: getOptionalStringFlag(flags, 'request-id') }
    )
    printResult(result, json, (value) => `Mission run ${value.runId} answer accepted.`)
  },
  'mission stop': async ({ flags, client, json }) => {
    const result = await client.call<{ runId: string; lifecycle: string }>(
      'mission.stop',
      {
        runId: getRequiredStringFlag(flags, 'run'),
        stopToken: getRequiredStringFlag(flags, 'stop-token'),
        reason: getOptionalStringFlag(flags, 'reason')
      },
      { orchestrationRequestId: getOptionalStringFlag(flags, 'request-id') }
    )
    printResult(result, json, (value) => `Mission run ${value.runId} ${value.lifecycle}.`)
  },
  'mission start': async ({ flags, client, cwd, json }) => {
    const mission = getRequiredStringFlag(flags, 'text')
    const worktree = await getBrowserWorktreeSelector(flags, cwd, client)
    if (!worktree) {
      throw new RuntimeClientError(
        'selector_not_found',
        'orca-sub requires an Orca-managed workspace. Run it inside a managed workspace or pass --worktree.'
      )
    }
    const explicitFrom = getOptionalStringFlag(flags, 'from')
    let fallbackFrom: string | undefined
    if (!explicitFrom) {
      try {
        const started = await client.call('mission.start', {
          text: mission,
          worktree,
          agent: getOptionalStringFlag(flags, 'agent'),
          model: getOptionalStringFlag(flags, 'model'),
          effort: getOptionalStringFlag(flags, 'effort'),
          requestId: getOptionalStringFlag(flags, 'request-id')
        }, { orchestrationRequestId: getOptionalStringFlag(flags, 'request-id') })
        printResult(started, json, (value) => `Mission run ${(value as { runId: string }).runId} detached.`)
        return
      } catch (error) {
        if (!(error instanceof RuntimeClientError) || error.code !== 'method_not_found') {
          throw error
        }
        try {
          fallbackFrom = await resolveCoordinatorTerminalHandle(flags, cwd, client)
        } catch {
          throw new RuntimeClientError('unsupported_host_runtime', 'Detached mission RPC is unavailable on this host/runtime.')
        }
      }
    }
    const from = explicitFrom ?? fallbackFrom ?? (await resolveCoordinatorTerminalHandle(flags, cwd, client))
    const planned = await client.call<MissionPlanRpcResult>('mission.plan', {
      text: mission,
      worktree,
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
      { objective, from }
    )
    const summary = await executeMissionRun({
      client,
      mission,
      runId: runResponse.result.run.id,
      from,
      worktree,
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
  }
}
