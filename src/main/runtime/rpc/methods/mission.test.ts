import { homedir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { RpcContext } from '../core'
import { MISSION_METHODS } from './mission'
import { detectInstalledAgentsWithShellPathHydration } from '../../../ipc/preflight'
import { generateTextFromPrompt } from '../../../text-generation/commit-message-text-generation'

vi.mock('../../../ipc/preflight', () => ({
  detectInstalledAgentsWithShellPathHydration: vi.fn()
}))

vi.mock('../../../text-generation/commit-message-text-generation', () => ({
  generateTextFromPrompt: vi.fn()
}))

const method = MISSION_METHODS.find((candidate) => candidate.name === 'mission.plan')!

describe('mission.plan', () => {
  let runtime: OrcaRuntimeService

  function setup(): void {
    vi.mocked(generateTextFromPrompt).mockReset()
    vi.mocked(detectInstalledAgentsWithShellPathHydration).mockReset()
    vi.mocked(detectInstalledAgentsWithShellPathHydration).mockResolvedValue(['pi', 'codex'])
    runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'getClientSettings').mockReturnValue({
      worktreeVisibilityDefaults: { external: 'hide' },
      defaultTuiAgent: 'pi',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {},
      agentStatusHooksEnabled: true,
      defaultTaskSource: 'github',
      defaultTaskViewPreset: 'issues',
      visibleTaskProviders: ['github'],
      defaultRepoSelection: null,
      defaultLinearTeamSelection: null,
      githubProjects: undefined,
      experimentalNewWorktreeCardStyle: false,
      compactWorktreeCards: false,
      minimaxGroupId: undefined,
      minimaxUsageModels: undefined,
      prBotAuthorOverrides: undefined,
      artifactSharingEnabled: false,
      agentSkillSharingEnabled: false
    } as unknown as ReturnType<OrcaRuntimeService['getClientSettings']>)
    vi.spyOn(runtime, 'showManagedTerminalWorkspace').mockResolvedValue({
      id: 'repo::worktree',
      path: '/repo'
    } as Awaited<ReturnType<OrcaRuntimeService['showManagedTerminalWorkspace']>>)
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function call(params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return method.handler(method.params!.parse(params), { runtime, signal } as RpcContext)
  }

  it('plans with the selected agent and returns the parsed orchestration plan', async () => {
    setup()
    const controller = new AbortController()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: JSON.stringify({
        mode: 'orchestration',
        objective: 'Parallel review',
        maxConcurrency: 2,
        tasks: [
          { key: 'a', spec: 'Inspect A', deps: [] },
          { key: 'b', spec: 'Inspect B', deps: [] }
        ]
      }),
      agentLabel: 'Pi'
    })

    const result = (await call(
      {
        text: 'Use two agents to inspect A and B in parallel.',
        worktree: 'id:repo::worktree',
        agent: 'pi'
      },
      controller.signal
    )) as { mission: string; agent: string; plan: { mode: string; maxConcurrency?: number } }

    expect(result).toMatchObject({
      mission: 'Use two agents to inspect A and B in parallel.',
      agent: 'pi',
      plan: { mode: 'orchestration', maxConcurrency: 2 }
    })
    expect(generateTextFromPrompt).toHaveBeenCalledWith(
      expect.stringContaining('Return JSON only'),
      expect.objectContaining({
        agentId: 'pi',
        model: 'github-copilot/gpt-5.4-mini'
      }),
      { kind: 'local', cwd: homedir() },
      'mission-plan',
      { useAgentDefaultModel: true, signal: controller.signal }
    )
  })

  it('rejects a pre-aborted request after workspace preflight without starting generation', async () => {
    setup()
    const controller = new AbortController()
    controller.abort()

    await expect(
      call(
        { text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' },
        controller.signal
      )
    ).rejects.toMatchObject({ code: 'request_aborted' })

    expect(runtime.showManagedTerminalWorkspace).toHaveBeenCalledWith('id:repo::worktree')
    expect(generateTextFromPrompt).not.toHaveBeenCalled()
  })

  it('maps a generation canceled by the request signal to request_aborted', async () => {
    setup()
    const controller = new AbortController()
    vi.mocked(generateTextFromPrompt).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          controller.signal.addEventListener(
            'abort',
            () => resolve({ success: false, error: 'Generation canceled.', canceled: true }),
            { once: true }
          )
        })
    )

    const planning = call(
      { text: 'Inspect this task.', worktree: 'id:repo::worktree' },
      controller.signal
    )
    await vi.waitFor(() => {
      expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
    })
    controller.abort()

    await expect(planning).rejects.toMatchObject({ code: 'request_aborted' })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not repair or fall back after cancellation during an invalid generation', async () => {
    setup()
    const controller = new AbortController()
    vi.mocked(generateTextFromPrompt).mockImplementationOnce(async () => {
      controller.abort()
      return { success: true, text: '{"mode":"single"}', agentLabel: 'Pi' }
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' }, controller.signal)
    ).rejects.toMatchObject({ code: 'request_aborted' })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
  })

  it('uses the configured default agent when --agent is omitted', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: '{"mode":"single-agent"}',
      agentLabel: 'Pi'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
    ).resolves.toMatchObject({ agent: 'pi', plan: { mode: 'single-agent' } })
  })

  it('falls back to the next detected agent when the preferred planner is unavailable', async () => {
    setup()
    vi.mocked(generateTextFromPrompt)
      .mockResolvedValueOnce({ success: false, error: 'Pi is not authenticated.' })
      .mockResolvedValueOnce({
        success: true,
        text: '{"mode":"single-agent"}',
        agentLabel: 'Codex'
      })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
    ).resolves.toMatchObject({ agent: 'codex', plan: { mode: 'single-agent' } })

    expect(
      vi.mocked(generateTextFromPrompt).mock.calls.map(([, params]) => params.agentId)
    ).toEqual(['pi', 'codex'])
  })

  it('does not fall back when --agent explicitly selects an unavailable planner', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: false,
      error: 'Pi is not authenticated.'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
    expect(vi.mocked(generateTextFromPrompt).mock.calls[0]?.[1].agentId).toBe('pi')
  })

  it('does not repair invalid output when less than one generation window remains', async () => {
    setup()
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(generateTextFromPrompt).mockImplementationOnce(async () => {
      now += 60_001
      return { success: true, text: '{"mode":"single"}', agentLabel: 'Pi' }
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(1)
  })

  it('does not fall back when the failed planner leaves less than one generation window', async () => {
    setup()
    let now = 1_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(generateTextFromPrompt).mockImplementationOnce(async () => {
      now += 60_001
      return { success: false, error: 'Pi is not authenticated.' }
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })

    expect(
      vi.mocked(generateTextFromPrompt).mock.calls.map(([, params]) => params.agentId)
    ).toEqual(['pi'])
  })

  it('rejects a disabled explicit agent with a stable error code', async () => {
    setup()
    vi.mocked(runtime.getClientSettings).mockReturnValue({
      ...runtime.getClientSettings(),
      disabledTuiAgents: ['pi']
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'agent_unconfigured' })
  })

  it('repairs one invalid planner response before failing the mission', async () => {
    setup()
    const controller = new AbortController()
    vi.mocked(generateTextFromPrompt)
      .mockResolvedValueOnce({
        success: true,
        text: '{"mode":"single"}',
        agentLabel: 'Pi'
      })
      .mockResolvedValueOnce({
        success: true,
        text: '{"mode":"single-agent"}',
        agentLabel: 'Pi'
      })

    await expect(
      call(
        { text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' },
        controller.signal
      )
    ).resolves.toMatchObject({ agent: 'pi', plan: { mode: 'single-agent' } })

    expect(generateTextFromPrompt).toHaveBeenCalledTimes(2)
    expect(vi.mocked(generateTextFromPrompt).mock.calls[1]?.[0]).toContain(
      'Repair the previous Mission Planner output'
    )
    expect(vi.mocked(generateTextFromPrompt).mock.calls[1]?.[4]).toEqual({
      useAgentDefaultModel: true,
      signal: controller.signal
    })
  })

  it('surfaces invalid planner output as mission_planner_failed after one repair attempt', async () => {
    setup()
    vi.mocked(generateTextFromPrompt).mockResolvedValue({
      success: true,
      text: 'not json',
      agentLabel: 'Pi'
    })

    await expect(
      call({ text: 'Inspect this task.', worktree: 'id:repo::worktree', agent: 'pi' })
    ).rejects.toMatchObject({ code: 'mission_planner_failed' })
  })
})
