import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrchestrationDb } from '../../orchestration/db'
import { RuntimeOrchestrationRunner } from '../../orchestration/orchestration-runtime-runner'
import { CollaborationKernel } from '../../collaboration/collaboration-kernel'
import * as preflight from '../../../ipc/preflight'
import { MISSION_METHODS } from './mission'

function mockSingleAgentPlanning(runtime: OrcaRuntimeService): void {
  vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
    id: 'repo::worktree',
    repoId: 'repo',
    path: '/tmp/repo'
  } as never)
  vi.spyOn(runtime, 'generateRuntimeText').mockResolvedValue({
    success: true,
    text: '{"mode":"single-agent"}',
    agentLabel: 'Planner'
  })
}

function method() {
  const found = MISSION_METHODS.find((candidate) => candidate.name === 'mission.start')
  if (!found) {
    throw new Error('mission.start not registered')
  }
  return found
}

beforeEach(() => {
  vi.stubEnv('ORCA_MISSION_DEFAULT_AGENT', '')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('mission.start', () => {
  it('launches the configured default agent in the selected workspace and injects the mission', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    } as never)
    mockSingleAgentPlanning(runtime)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_mission',
      worktreeId: 'repo::worktree',
      title: 'Codex'
    } as never)
    vi.spyOn(runtime, 'focusTerminal').mockResolvedValue({
      handle: 'term_mission',
      tabId: 'tab_mission',
      worktreeId: 'repo::worktree',
      navigated: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_mission',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_mission',
      accepted: true,
      bytesWritten: 42
    })

    const rpc = method()
    const params = rpc.params?.parse({
      text: 'refactor login safely',
      worktree: 'id:repo::worktree'
    })
    const result = await rpc.handler(params, { runtime } as never)

    expect(runtime.createTerminal).toHaveBeenCalledWith('id:repo::worktree', {
      startupAgent: 'codex',
      title: 'Mission'
    })
    expect(runtime.focusTerminal).toHaveBeenCalledWith('term_mission')
    expect(runtime.waitForTerminal).toHaveBeenCalledWith('term_mission', {
      condition: 'tui-idle',
      timeoutMs: 60_000
    })
    expect(runtime.sendTerminalAgentPrompt).toHaveBeenCalledWith(
      'term_mission',
      'refactor login safely'
    )
    expect(result).toMatchObject({
      mission: 'refactor login safely',
      mode: 'single-agent',
      agent: 'codex',
      terminal: { handle: 'term_mission' }
    })
  })

  it('lets an explicit mission agent override the Orca default', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    } as never)
    mockSingleAgentPlanning(runtime)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_explicit',
      worktreeId: 'repo::worktree',
      title: 'Claude'
    } as never)
    vi.spyOn(runtime, 'focusTerminal').mockResolvedValue({
      handle: 'term_explicit',
      tabId: 'tab_explicit',
      worktreeId: 'repo::worktree',
      navigated: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_explicit',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_explicit',
      accepted: true,
      bytesWritten: 10
    })

    const rpc = method()
    const params = rpc.params?.parse({
      text: 'do the work',
      worktree: 'id:repo::worktree',
      agent: 'claude'
    })
    const result = await rpc.handler(params, { runtime } as never)

    expect(result).toMatchObject({ agent: 'claude' })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'claude' })
    )
  })

  it('allows a local environment override without changing Orca defaults', async () => {
    vi.stubEnv('ORCA_MISSION_DEFAULT_AGENT', 'pi')
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    } as never)
    vi.spyOn(preflight, 'detectInstalledAgentsWithShellPathHydration').mockResolvedValue(['pi'])
    mockSingleAgentPlanning(runtime)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_local_default',
      worktreeId: 'repo::worktree',
      title: 'Pi'
    } as never)
    vi.spyOn(runtime, 'focusTerminal').mockResolvedValue({
      handle: 'term_local_default',
      tabId: 'tab_local_default',
      worktreeId: 'repo::worktree',
      navigated: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_local_default',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_local_default',
      accepted: true,
      bytesWritten: 10
    })

    const rpc = method()
    const params = rpc.params?.parse({ text: 'do the work', worktree: 'id:repo::worktree' })
    const result = await rpc.handler(params, { runtime } as never)

    expect(result).toMatchObject({ agent: 'pi' })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'pi' })
    )
  })

  it('falls back to Orca agent detection when no default agent is configured', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: null,
      disabledTuiAgents: []
    } as never)
    vi.spyOn(preflight, 'detectInstalledAgentsWithShellPathHydration').mockResolvedValue(['codex'])
    mockSingleAgentPlanning(runtime)
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_fallback',
      worktreeId: 'repo::worktree',
      title: 'Codex'
    } as never)
    vi.spyOn(runtime, 'focusTerminal').mockResolvedValue({
      handle: 'term_fallback',
      tabId: 'tab_fallback',
      worktreeId: 'repo::worktree',
      navigated: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_fallback',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_fallback',
      accepted: true,
      bytesWritten: 10
    })

    const rpc = method()
    const params = rpc.params?.parse({ text: 'do the work', worktree: 'id:repo::worktree' })
    const result = await rpc.handler(params, { runtime } as never)

    expect(result).toMatchObject({ agent: 'codex', terminal: { handle: 'term_fallback' } })
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'codex' })
    )
  })

  it('keeps unsupported planner agents on the existing single-agent path', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: []
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo',
      path: '/tmp/repo'
    } as never)
    const generateRuntimeText = vi.spyOn(runtime, 'generateRuntimeText')
    vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
      handle: 'term_grok',
      worktreeId: 'repo::worktree',
      title: 'Grok'
    } as never)
    vi.spyOn(runtime, 'focusTerminal').mockResolvedValue({
      handle: 'term_grok',
      tabId: 'tab_grok',
      worktreeId: 'repo::worktree',
      navigated: true
    })
    vi.spyOn(runtime, 'waitForTerminal').mockResolvedValue({
      handle: 'term_grok',
      condition: 'tui-idle',
      satisfied: true,
      status: 'running',
      exitCode: null
    })
    vi.spyOn(runtime, 'sendTerminalAgentPrompt').mockResolvedValue({
      handle: 'term_grok',
      accepted: true,
      bytesWritten: 10
    })

    const rpc = method()
    const params = rpc.params?.parse({
      text: 'do the work',
      worktree: 'id:repo::worktree',
      agent: 'grok'
    })
    const result = await rpc.handler(params, { runtime } as never)

    expect(result).toMatchObject({ mode: 'single-agent', agent: 'grok' })
    expect(generateRuntimeText).not.toHaveBeenCalled()
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:repo::worktree',
      expect.objectContaining({ startupAgent: 'grok' })
    )
  })

  it('routes a planner-produced DAG into the deterministic orchestration runtime', async () => {
    const db = new OrchestrationDb(':memory:')
    const runtime = new OrcaRuntimeService()
    runtime.setOrchestrationDb(db)
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    } as never)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      repoId: 'repo',
      path: '/tmp/repo'
    } as never)
    vi.spyOn(runtime, 'generateRuntimeText').mockResolvedValue({
      success: true,
      text: JSON.stringify({
        mode: 'orchestration',
        objective: 'Inspect both layers and integrate them',
        maxConcurrency: 2,
        tasks: [
          {
            key: 'mission',
            spec: 'Inspect Mission entry',
            deps: [],
            publishesTo: ['/mission/findings']
          },
          {
            key: 'control',
            spec: 'Inspect orchestration control plane',
            deps: [],
            subscribesTo: ['/mission/findings'],
            admission: { acceptedTypes: ['finding'], minPriority: 'high' }
          },
          { key: 'integrate', spec: 'Integrate both findings', deps: ['mission', 'control'] }
        ]
      }),
      agentLabel: 'Codex'
    })
    const runExisting = vi
      .spyOn(RuntimeOrchestrationRunner.prototype, 'runExisting')
      .mockImplementation(async (runId) => ({ runId, state: 'completed' }))
    const collaborationStart = vi.spyOn(CollaborationKernel.prototype, 'start')
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    try {
      const rpc = method()
      const params = rpc.params?.parse({
        text: 'Inspect both layers in parallel and integrate them',
        worktree: 'id:repo::worktree'
      })
      const result = await rpc.handler(params, { runtime } as never)

      expect(result).toMatchObject({
        mission: 'Inspect both layers in parallel and integrate them',
        mode: 'orchestration',
        agent: 'codex',
        state: 'running'
      })
      expect(createTerminal).not.toHaveBeenCalled()
      expect(collaborationStart).toHaveBeenCalledWith({
        objective: 'Inspect both layers and integrate them',
        maxConcurrency: 2,
        steps: [
          {
            key: 'mission',
            instruction: 'Inspect Mission entry',
            dependsOn: [],
            contextFrom: [],
            publishesTo: ['/mission/findings']
          },
          {
            key: 'control',
            instruction: 'Inspect orchestration control plane',
            dependsOn: [],
            contextFrom: [],
            subscribesTo: ['/mission/findings'],
            admission: { acceptedTypes: ['finding'], minPriority: 'high' }
          },
          {
            key: 'integrate',
            instruction: 'Integrate both findings',
            dependsOn: ['mission', 'control'],
            contextFrom: ['mission', 'control']
          }
        ]
      })
      const runId = (result as { runId: string }).runId
      expect(runExisting).toHaveBeenCalledWith(runId)
      const tasks = db.listTasks({ runId })
      expect(tasks).toHaveLength(3)
      for (const task of tasks) {
        expect(JSON.parse(task.execution_spec ?? '')).toEqual({
          backend: 'local-worker',
          config: {
            worktreeId: 'repo::worktree',
            agent: 'codex',
            timeoutMs: 60_000
          }
        })
      }
    } finally {
      db.close()
    }
  })

  it('respects an explicit blank default and refuses to launch an agent', async () => {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      defaultTuiAgent: 'blank',
      disabledTuiAgents: []
    } as never)
    const createTerminal = vi.spyOn(runtime, 'createTerminal')

    const rpc = method()
    const params = rpc.params?.parse({ text: 'do the work', worktree: 'id:repo::worktree' })

    await expect(rpc.handler(params, { runtime } as never)).rejects.toMatchObject({
      code: 'agent_unconfigured'
    })
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
