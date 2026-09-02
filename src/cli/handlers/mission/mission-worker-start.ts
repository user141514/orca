import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { isDevCliInvocation } from '../orchestration/runtime-compatibility'

const AMBIGUOUS_PROMPT_SETTLEMENT_MS = 45_000
const RETRYABLE_WORKER_START_STAGES = new Set(['terminal_create', 'agent_readiness'])

type RuntimeTask = {
  id: string
  status: 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
}

type MissionWorkerStartResult = {
  taskId: string
  dispatchId: string
  state: string
  failedStage?: string
  lastError?: string
}

type MissionWorkerStartInput = {
  client: RuntimeClient
  runId: string
  from: string
  worktree: string
  agent: string
  agentCandidates?: readonly string[]
}

export async function startMissionWorker(
  input: MissionWorkerStartInput,
  taskId: string
): Promise<void> {
  const candidates = input.agentCandidates?.length ? input.agentCandidates : [input.agent]
  const failures: string[] = []
  let retryOf: string | undefined

  for (const [index, agent] of candidates.entries()) {
    try {
      const worker = await input.client.call<MissionWorkerStartResult>('orchestration.workerStart', {
        task: taskId,
        run: input.runId,
        from: input.from,
        worktree: input.worktree,
        agent,
        ...(retryOf ? { retryOf } : {}),
        devMode: isDevCliInvocation()
      })
      if (worker.result.state === 'ready') {
        return
      }

      const reason =
        worker.result.lastError ?? `Worker ${worker.result.dispatchId} failed to become ready.`
      if (
        worker.result.failedStage === 'dispatch_input' &&
        reason === 'agent_prompt_stalled' &&
        (await reconcileAmbiguousPromptDelivery(input, taskId))
      ) {
        return
      }
      const hasNext = index + 1 < candidates.length
      if (hasNext && RETRYABLE_WORKER_START_STAGES.has(worker.result.failedStage ?? '')) {
        failures.push(`${agent}: ${reason}`)
        retryOf = worker.result.dispatchId
        continue
      }
      throw new RuntimeClientError('mission_worker_start_failed', reason)
    } catch (error) {
      if (
        error instanceof RuntimeClientError &&
        error.code === 'agent_prompt_stalled' &&
        (await reconcileAmbiguousPromptDelivery(input, taskId))
      ) {
        return
      }
      const hasNext = index + 1 < candidates.length
      if (hasNext && error instanceof RuntimeClientError && error.code === 'agent_unconfigured') {
        failures.push(`${agent}: ${error.message}`)
        continue
      }
      throw error
    }
  }

  throw new RuntimeClientError(
    'mission_worker_start_failed',
    `No mission agent could start task ${taskId}: ${failures.join('; ')}`
  )
}

async function reconcileAmbiguousPromptDelivery(
  input: Pick<MissionWorkerStartInput, 'client' | 'runId' | 'from'>,
  taskId: string
): Promise<boolean> {
  const readTask = async (): Promise<RuntimeTask | undefined> => {
    const listed = await input.client.call<{ tasks: RuntimeTask[]; count: number }>(
      'orchestration.taskList',
      { run: input.runId, callerTerminalHandle: input.from }
    )
    return listed.result.tasks.find((task) => task.id === taskId)
  }

  const initial = await readTask()
  if (initial?.status === 'dispatched' || initial?.status === 'completed') {
    return true
  }

  const waited = await input.client.call<{
    deliveryId: string | null
    timedOut?: boolean
    cancelled?: boolean
    connectionLost?: boolean
  }>('orchestration.check', {
    terminal: input.from,
    run: input.runId,
    wait: true,
    timeoutMs: AMBIGUOUS_PROMPT_SETTLEMENT_MS,
    types: 'worker_done,escalation'
  })
  if (waited.result.deliveryId) {
    await input.client.call('orchestration.check', {
      terminal: input.from,
      run: input.runId,
      ack: waited.result.deliveryId,
      peek: true
    })
  }
  const settled = await readTask()
  return settled?.status === 'dispatched' || settled?.status === 'completed'
}
