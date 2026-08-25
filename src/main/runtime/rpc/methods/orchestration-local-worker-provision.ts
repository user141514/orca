import type { AgentLaunchPreferences } from '../../../../shared/agent-session-host-authority'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../../orchestration/db'
import { buildDispatchPreamble } from '../../orchestration/preamble'
import {
  createExistingWorktreeWorkerTerminal,
  createWorkerWorktree,
  monitorWorkerSetup,
  requireWorkerAuthority,
  type WorkerEffect,
  type WorkerSetupReceipt
} from './orchestration-worker-topology'
import {
  persistGatedSetupSpawnFailure,
  persistWorkerReadinessStage,
  persistWorkerSetupWaitOutcome
} from './orchestration-worker-setup-gate'
import {
  failWorkerStartWithReceipt,
  type WorkerStartFailureReceipt
} from './orchestration-worker-start-receipt'
import type { OrchestrationWorkerLaunchReceipt } from './orchestration-worker-launch-preferences'
import type { WorkerDispatchState } from '../../orchestration/types'

type CoordinatorWorktree = Pick<
  Awaited<ReturnType<OrcaRuntimeService['showManagedWorktree']>>,
  'id' | 'repoId'
>

export type LocalWorkerProvisionPlacement =
  | {
      kind: 'existing-workspace'
      worktreeId: string
      terminalHandle?: string
    }
  | {
      kind: 'new-worktree'
      requestedWorktree: 'new-child' | 'new-top-level'
      coordinatorWorktree: CoordinatorWorktree
      creation: {
        repo?: string
        name: string
        baseBranch?: string
        displayName?: string
        comment?: string
        setup?: 'run' | 'skip' | 'inherit'
        callerTerminalHandle?: string
      }
    }

export type LocalWorkerTaskProtocolInstructionBuilder = (input: {
  cli: string
  taskId: string
  dispatchId: string
  workerHandle: string
  dispatchCapability: string
}) => string

export type AcceptedLocalWorkerProvision = {
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  runId: string
  task: { id: string; spec: string }
  dispatchId: string
  coordinatorAddress: string
  placement: LocalWorkerProvisionPlacement
  agent?: TuiAgent
  launch: {
    preferences: AgentLaunchPreferences | undefined
    receipt: OrchestrationWorkerLaunchReceipt
  }
  timeoutMs: number
  devMode?: boolean
  buildTaskProtocolInstructions?: LocalWorkerTaskProtocolInstructionBuilder
}

export type LocalWorkerProvisionReceipt = {
  runId: string
  taskId: string
  dispatchId: string
  state: WorkerDispatchState
  stage: string
  setup: WorkerSetupReceipt
  launch: OrchestrationWorkerLaunchReceipt
  timeoutMs: number
  effects: WorkerEffect[]
  residualResources: unknown[]
  warning?: string
}

export async function provisionAcceptedLocalWorker(
  args: AcceptedLocalWorkerProvision
): Promise<LocalWorkerProvisionReceipt | WorkerStartFailureReceipt> {
  const { runtime, db, task, dispatchId, placement } = args
  const effects: WorkerEffect[] = []
  let resolvedWorktreeId =
    placement.kind === 'existing-workspace' ? placement.worktreeId : undefined
  if (resolvedWorktreeId) {
    effects.push(
      { kind: 'worktree', action: 'reused', id: resolvedWorktreeId },
      { kind: 'setup', action: 'not_applicable', state: 'not_applicable' }
    )
  }
  let terminalHandle =
    placement.kind === 'existing-workspace' ? placement.terminalHandle : undefined
  let terminalRevealWarning: string | undefined
  let failedStage = 'terminal_create'
  let setupReceipt: WorkerSetupReceipt = {
    requested: 'not_applicable',
    effective: 'not_applicable',
    source: 'existing_worktree',
    hookFound: false,
    startupPolicy: 'start-immediately',
    state: 'not_applicable'
  }

  try {
    if (placement.kind === 'new-worktree') {
      if (!args.agent) {
        throw new Error('A configured agent is required when provisioning a new worktree.')
      }
      failedStage = 'worktree_create'
      const created = await createWorkerWorktree({
        runtime,
        db,
        dispatchId,
        requestedWorktree: placement.requestedWorktree,
        coordinatorWorktree: placement.coordinatorWorktree,
        creation: placement.creation,
        agent: args.agent,
        launchPreferences: args.launch.preferences,
        effects
      })
      resolvedWorktreeId = created.worktree.id
      terminalHandle = created.terminalHandle
      setupReceipt = created.setupReceipt
    } else if (!terminalHandle) {
      if (!args.agent) {
        throw new Error('A configured agent is required when provisioning a worker terminal.')
      }
      db.recordWorkerStage({
        dispatchId,
        stage: 'terminal_creating',
        worktreeId: placement.worktreeId,
        effects
      })
      const terminal = await createExistingWorktreeWorkerTerminal({
        runtime,
        worktreeId: placement.worktreeId,
        agent: args.agent,
        launchPreferences: args.launch.preferences,
        taskId: task.id,
        effects
      })
      terminalHandle = terminal.handle
      terminalRevealWarning = terminal.warning
    } else {
      effects.push({
        kind: 'terminal',
        role: 'agent',
        action: 'reused',
        id: terminalHandle
      })
    }

    if (!resolvedWorktreeId || !terminalHandle) {
      throw new Error('Worker topology did not resolve an agent terminal and worktree.')
    }
    const setupStage = {
      db,
      dispatchId,
      worktreeId: resolvedWorktreeId,
      terminalHandle,
      setup: setupReceipt,
      effects
    }
    if (persistGatedSetupSpawnFailure(setupStage)) {
      failedStage = 'setup_start'
      throw new Error('Setup terminal failed to start before the gated agent launch.')
    }
    persistWorkerReadinessStage(setupStage)

    failedStage = 'agent_readiness'
    const wait = await runtime.waitForTerminal(terminalHandle, {
      condition: 'tui-idle',
      timeoutMs: args.timeoutMs
    })
    persistWorkerSetupWaitOutcome({ ...setupStage, wait })
    if (!wait.satisfied) {
      if (setupReceipt.state === 'failed') {
        failedStage = 'setup_wait'
      }
      throw new Error(
        wait.blockedReason
          ? `Agent startup blocked: ${wait.blockedReason}`
          : `Agent did not become ready (${wait.status}).`
      )
    }

    const terminalAuthority = requireWorkerAuthority(runtime, terminalHandle)
    const capability = db.prepareStartingWorkerAuthority({
      dispatchId,
      handle: terminalHandle,
      ...terminalAuthority,
      worktreeId: resolvedWorktreeId,
      effects,
      setupState: setupReceipt.state,
      terminalOwnership:
        placement.kind === 'existing-workspace' && placement.terminalHandle ? 'external' : 'created'
    })

    failedStage = 'dispatch_input'
    const cliCommand = runtime.getTerminalOrchestrationCliCommand(terminalHandle)
    const protocolInstructions = args.buildTaskProtocolInstructions?.({
      cli: args.devMode ? 'orca-dev' : cliCommand,
      taskId: task.id,
      dispatchId,
      workerHandle: terminalHandle,
      dispatchCapability: capability
    })
    const taskSpec = protocolInstructions?.trim()
      ? `${protocolInstructions.trim()}\n\n=== ASSIGNMENT ===\n${task.spec}`
      : task.spec
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId,
      taskSpec,
      coordinatorHandle: args.coordinatorAddress,
      workerHandle: terminalHandle,
      dispatchCapability: capability,
      devMode: args.devMode,
      cliCommand
    })
    await runtime.sendTerminalAgentPrompt(terminalHandle, preamble)
    effects.push({
      kind: 'dispatch_input',
      role: 'agent',
      id: terminalHandle,
      state: 'accepted'
    })
    const worker = db.markWorkerDispatchReady(dispatchId, effects)
    monitorWorkerSetup({
      runtime,
      db,
      runId: args.runId,
      dispatchId,
      setupReceipt,
      effects
    })
    return {
      runId: args.runId,
      taskId: task.id,
      dispatchId,
      state: worker.state,
      stage: worker.stage,
      setup: setupReceipt,
      launch: args.launch.receipt,
      timeoutMs: args.timeoutMs,
      effects,
      residualResources: [],
      ...(terminalRevealWarning ? { warning: terminalRevealWarning } : {})
    }
  } catch (error) {
    return failWorkerStartWithReceipt({
      db,
      runId: args.runId,
      taskId: task.id,
      dispatchId,
      failedStage,
      error,
      setup: setupReceipt,
      launch: args.launch.receipt
    })
  }
}
