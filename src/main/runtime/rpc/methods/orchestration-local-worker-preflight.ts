import type { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationError } from '../../orchestration/orchestration-error'
import { assertOrchestrationWorktreeCreationSupported } from './orchestration-folder-worktree-placement'
import type { LocalWorkerProvisionPlacement } from './orchestration-local-worker-provision'
import type { WorkerStartInput } from './orchestration-worker-start-schema'
import { prepareLocalWorkerStart } from './orchestration-worker-start-validation'

export async function prepareLocalWorkerDispatchAcceptance(args: {
  runtime: OrcaRuntimeService
  params: WorkerStartInput
}) {
  const { runtime, params } = args
  const requestedWorktree = params.worktree ?? 'current'
  const createsWorktree = requestedWorktree === 'new-child' || requestedWorktree === 'new-top-level'
  const { agent, launch } = prepareLocalWorkerStart({ params, createsWorktree, runtime })
  const coordinatorTerminal = await runtime.showTerminal(params.from)

  if (createsWorktree) {
    const name = params.name
    if (!name) {
      throw new OrchestrationError('invalid_argument', 'New worktrees require --name.')
    }
    const coordinatorWorktree = await runtime.showManagedWorktree(
      `id:${coordinatorTerminal.worktreeId}`
    )
    await assertOrchestrationWorktreeCreationSupported({
      runtime,
      repoSelector: params.repo ?? coordinatorWorktree.repoId,
      existingPlacement: 'current or an exact existing folder workspace'
    })
    const placement: LocalWorkerProvisionPlacement = {
      kind: 'new-worktree',
      requestedWorktree,
      coordinatorWorktree,
      creation: {
        repo: params.repo,
        name,
        baseBranch: params.baseBranch,
        displayName: params.displayName,
        comment: params.comment,
        setup: params.setup,
        callerTerminalHandle: params.from
      }
    }
    return {
      agent,
      launch,
      placement,
      startOptions: {
        worktree: requestedWorktree,
        resolvedWorktreeId: null,
        name,
        repo: params.repo ?? coordinatorWorktree.repoId ?? null,
        baseBranch: params.baseBranch ?? null,
        terminal: null,
        agent: agent ?? null,
        launch: launch.receipt,
        timeoutMs: params.timeoutMs ?? 60_000,
        setup: params.setup ?? 'run',
        setupSource: params.setup ? 'explicit_request' : 'orchestration_default'
      }
    }
  }

  const resolvedWorkspace =
    requestedWorktree === 'current'
      ? await runtime.showManagedTerminalWorkspace(`id:${coordinatorTerminal.worktreeId}`)
      : await runtime.showManagedTerminalWorkspace(requestedWorktree)
  if (params.terminal) {
    const terminal = await runtime.showTerminal(params.terminal)
    if (terminal.worktreeId !== resolvedWorkspace.id) {
      throw new OrchestrationError(
        'terminal_worktree_mismatch',
        `Terminal ${params.terminal} does not belong to worktree ${resolvedWorkspace.id}.`
      )
    }
    if (!(await runtime.isTerminalRunningAgent(params.terminal))) {
      throw new OrchestrationError(
        'agent_unconfigured',
        `Terminal ${params.terminal} is not running a recognized agent.`
      )
    }
  }

  const placement: LocalWorkerProvisionPlacement = {
    kind: 'existing-workspace',
    worktreeId: resolvedWorkspace.id,
    ...(params.terminal ? { terminalHandle: params.terminal } : {})
  }
  return {
    agent,
    launch,
    placement,
    startOptions: {
      worktree: requestedWorktree,
      resolvedWorktreeId: resolvedWorkspace.id,
      name: null,
      repo: null,
      baseBranch: null,
      terminal: params.terminal ?? null,
      agent: agent ?? null,
      launch: launch.receipt,
      timeoutMs: params.timeoutMs ?? 60_000,
      setup: 'not_applicable',
      setupSource: 'existing_worktree'
    }
  }
}
