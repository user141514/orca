import type { CommitMessagePlan } from '../../shared/commit-message-plan'
import {
  resolveCodexHomeProcessLockKeyForSpawnEnv,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import {
  clearLocalGenerationCancelToken,
  localGenerationLaneKey,
  setLocalGenerationCancelToken
} from './source-control-generation-lanes'
import { runLocalSourceControlPlan } from './source-control-local-process'
import type {
  InternalTextGenerationResult,
  LocalGenerationTarget,
  LocalProcessExecution,
  SpawnSourceControlAgent,
  TextGenerationOperation
} from './source-control-text-generation-types'

export function runLocalPlanForAgent(input: {
  agentId: string
  plan: CommitMessagePlan
  target: LocalGenerationTarget
  emptyResultName: string
  operation: TextGenerationOperation
  signal?: AbortSignal
  spawnAgent: SpawnSourceControlAgent
}): Promise<InternalTextGenerationResult> {
  const start = (
    holdHomeLockUntilExit = false
  ): LocalProcessExecution<InternalTextGenerationResult> =>
    runLocalSourceControlPlan({
      plan: input.plan,
      cwd: input.target.cwd,
      env: input.target.env,
      emptyResultName: input.emptyResultName,
      operation: input.operation,
      signal: input.signal,
      wslDistro: input.target.wslDistro,
      holdHomeLockUntilExit,
      spawnAgent: input.spawnAgent
    })
  if (input.agentId !== 'codex') {
    return start().result
  }
  return runCodexLocalPlanUnderHomeLock(start, input.target, input.operation, input.signal)
}

function runCodexLocalPlanUnderHomeLock(
  start: (holdHomeLockUntilExit: boolean) => LocalProcessExecution<InternalTextGenerationResult>,
  target: LocalGenerationTarget,
  operation: TextGenerationOperation,
  signal?: AbortSignal
): Promise<InternalTextGenerationResult> {
  if (signal?.aborted) {
    return Promise.resolve({ success: false, error: 'Generation canceled.', canceled: true })
  }
  const laneKey = localGenerationLaneKey(operation, target.cwd)
  let canceledWhileQueued = false
  let dequeued = false
  let detachAbortListener = (): void => {}
  let publishResult!: (result: InternalTextGenerationResult) => void
  let rejectResult!: (error: unknown) => void
  let resultPublished = false
  const result = new Promise<InternalTextGenerationResult>((resolve, reject) => {
    publishResult = (value) => {
      if (!resultPublished) {
        resultPublished = true
        resolve(value)
      }
    }
    rejectResult = reject
  })
  const queuedCancel = (): void => {
    if (dequeued) {
      return
    }
    canceledWhileQueued = true
    publishResult({ success: false, error: 'Generation canceled.', canceled: true })
  }
  setLocalGenerationCancelToken(laneKey, queuedCancel)
  if (signal) {
    signal.addEventListener('abort', queuedCancel, { once: true })
    detachAbortListener = () => signal.removeEventListener('abort', queuedCancel)
    if (signal.aborted) {
      queuedCancel()
    }
  }
  void withCodexHomeProcessLock(
    resolveCodexHomeProcessLockKeyForSpawnEnv(target.env, target.wslDistro),
    async () => {
      if (canceledWhileQueued) {
        publishResult({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      dequeued = true
      detachAbortListener()
      if (signal?.aborted) {
        publishResult({ success: false, error: 'Generation canceled.', canceled: true })
        return
      }
      const execution = start(true)
      try {
        publishResult(await execution.result)
      } catch (error) {
        if (!resultPublished) {
          rejectResult(error)
        }
      } finally {
        await execution.processClosed
      }
    }
  )
    .catch((error: unknown) => {
      if (!resultPublished) {
        rejectResult(error)
      }
    })
    .finally(() => {
      detachAbortListener()
      clearLocalGenerationCancelToken(laneKey, queuedCancel)
    })
  return result
}

export function runCodexProcessWithHomeLock<T>(
  lockKey: string,
  start: () => LocalProcessExecution<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    void withCodexHomeProcessLock(lockKey, async () => {
      const execution = start()
      try {
        resolve(await execution.result)
      } catch (error) {
        reject(error)
      } finally {
        await execution.processClosed
      }
    }).catch(reject)
  })
}
