// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithSerializeAgentPromptSubmission } from './orca-runtime-serialize-agent-prompt-submission'
import type { RuntimeTerminalAgentStatusSnapshot } from './runtime-terminal-agent-status-query'
import type { AgentStatus } from '../../shared/agent-detection'
import type { RuntimeTerminalWaitBlockedReason } from '../../shared/runtime-types'
import {
  detectTerminalWaitBlockedReason,
  findCodexReadyPromptIndex,
  isKnownReadyPromptPreview,
  isSettledReadyPromptPreview
} from './terminal-wait-detection'
import { TUI_IDLE_QUIESCENCE_MS } from './orca-runtime-postlude'
import { isOpenCodeNativeTitle } from '../../shared/agent-detection'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { renewRuntimeMobileAgentStatusFromPtyTitle } from './runtime-mobile-agent-status-projection'
import type { RuntimeTerminalWriteOptions } from './runtime-terminal-writer'
import type { AgentSessionPtyWriteAdmittance } from './agent-session-pty-write-gate'
import { getRegisteredSshState } from '../ssh/ssh-target-registry'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import type { TuiAgent } from '../../shared/tui-agent'
import type { AgentPromptActivity } from './agent-prompt-submission-verification'

const AGENT_PROMPT_TERMINAL_EVIDENCE_CARRY_CHARS = 256
const CODEX_TERMINAL_WORKING_INDICATOR = /\bWorking\s*\([^)]{0,160}\besc to interrupt\b/i

export class OrcaRuntimeWithResolveAuthoritativeTerminalWaitPermission extends OrcaRuntimeWithSerializeAgentPromptSubmission {
  protected resolveAuthoritativeTerminalWaitPermission(
    terminal: RuntimeTerminalAgentStatusSnapshot,
    explicitStatus: { status: AgentStatus; updatedAt: number } | null,
    lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined
  ): RuntimeTerminalWaitBlockedReason | null {
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    if (!blockedByWaitText) {
      return null
    }
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      !isOpenCodeNativeTitle(terminal.title) &&
      blockedByWaitText !== 'agent-approval-prompt'
    if (liveTitleClearsBlockedText && lifecycle?.status !== terminal.titleStatus) {
      return null
    }
    if (blockedByWaitText === 'agent-approval-prompt') {
      return blockedByWaitText
    }
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    return newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt ? blockedByWaitText : null
  }

  renewMobileAgentStatusFromPtyTitle(
    status: AgentStatusEntry | null,
    pty: RuntimePtyWorktreeRecord | null,
    options: { preserveQuestionUnderShellTitle?: boolean } = {}
  ): AgentStatusEntry | null {
    return renewRuntimeMobileAgentStatusFromPtyTitle(status, pty, options)
  }

  protected writeTerminalAction(
    ptyId: string,
    action: { text?: string; enter?: boolean; interrupt?: boolean },
    payload: string,
    options: RuntimeTerminalWriteOptions = {}
  ): Promise<void> {
    return this.terminalWriter.writeAction(ptyId, action, payload, options)
  }

  protected writeTerminalInputChunks(
    ptyId: string,
    text: string,
    options: RuntimeTerminalWriteOptions = {},
    admitted?: AgentSessionPtyWriteAdmittance
  ): Promise<void> {
    return this.terminalWriter.writeChunks(ptyId, text, options, admitted)
  }

  /** Platform of the host whose pty transport ingests our writes -- deliberately NOT the OS
   *  the command runs under. A WSL pane is spawned as `wsl.exe` through the Windows ConPTY
   *  (see local-pty-provider), so it pays the ConPTY ingest cost even though its shell is
   *  Linux; an SSH pane is spawned by node-pty on the remote host, so the client's
   *  process.platform says nothing about it. */
  protected getPtyWriteHostPlatform(ptyId: string): NodeJS.Platform {
    const pty = this.ptysById.get(ptyId)
    const connectionId = pty?.connectionId
    if (!connectionId) {
      return process.platform
    }
    const remotePlatform = getRegisteredSshState(connectionId)?.remotePlatform
    if (remotePlatform) {
      return remotePlatform
    }
    // Why: remotePlatform only arrives with the relay handshake; until then the worktree path
    // flavor is the same signal getAgentLaunchPlatformForRepo already trusts for a remote repo.
    const worktreePath = pty ? splitWorktreeIdForFilesystem(pty.worktreeId)?.worktreePath : null
    return worktreePath && isWindowsAbsolutePathLike(worktreePath) ? 'win32' : 'linux'
  }

  protected getPtyAgent(ptyId: string): TuiAgent | null {
    const pty = this.ptysById.get(ptyId)
    return pty?.launchAgent ?? pty?.foregroundAgent ?? null
  }

  protected canResolveTuiIdlePromptPreview(
    ptyId: string | null,
    waitText: string,
    lastOutputAt: number | null
  ): boolean {
    if (!ptyId || this.getPtyAgent(ptyId) !== 'codex') {
      return isKnownReadyPromptPreview(waitText)
    }
    if (
      this.agentPromptAcceptedGenerationByPtyId.get(ptyId) === this.getPtyLifecycleGeneration(ptyId)
    ) {
      return true
    }
    return isSettledReadyPromptPreview(waitText, lastOutputAt, TUI_IDLE_QUIESCENCE_MS)
  }

  protected canResolveTuiIdleEvidence(
    ptyId: string | null,
    waitText: string,
    lastOutputAt: number | null
  ): boolean {
    const hasCodexPrompt = findCodexReadyPromptIndex(waitText.toLowerCase()) !== null
    if (!ptyId) {
      return (
        !hasCodexPrompt ||
        isSettledReadyPromptPreview(waitText, lastOutputAt, TUI_IDLE_QUIESCENCE_MS)
      )
    }
    const pty = this.ptysById.get(ptyId)
    const isCodex =
      this.getPtyAgent(ptyId) === 'codex' ||
      hasCodexPrompt ||
      pty?.lastOscTitle?.toLowerCase().includes('codex') === true
    if (!isCodex) {
      return true
    }
    const acceptedGeneration = this.agentPromptAcceptedGenerationByPtyId.get(ptyId)
    return (
      (acceptedGeneration !== undefined &&
        acceptedGeneration === this.getPtyLifecycleGeneration(ptyId)) ||
      isSettledReadyPromptPreview(waitText, lastOutputAt, TUI_IDLE_QUIESCENCE_MS)
    )
  }

  protected recordAgentPromptTerminalEvidence(ptyId: string, text: string): void {
    const carry = this.agentPromptTerminalEvidenceCarryByPtyId.get(ptyId) ?? ''
    const combined = `${carry}${text}`
    const marker = CODEX_TERMINAL_WORKING_INDICATOR.exec(combined)
    CODEX_TERMINAL_WORKING_INDICATOR.lastIndex = 0
    if (marker && marker.index + marker[0].length > carry.length) {
      this.agentPromptTerminalWorkingSequenceByPtyId.set(
        ptyId,
        (this.agentPromptTerminalWorkingSequenceByPtyId.get(ptyId) ?? 0) + 1
      )
    }
    this.agentPromptTerminalEvidenceCarryByPtyId.set(
      ptyId,
      combined.slice(-AGENT_PROMPT_TERMINAL_EVIDENCE_CARRY_CHARS)
    )
  }

  protected assertAgentPromptPermissionSafe(
    baseline: AgentPromptActivity,
    current: AgentPromptActivity
  ): void {
    if (
      current.status === 'permission' ||
      current.permissionSequence > baseline.permissionSequence
    ) {
      throw new Error('agent_prompt_blocked')
    }
  }

  protected assertAgentPromptGeneration(ptyId: string, expected: number): void {
    if (this.getPtyLifecycleGeneration(ptyId) !== expected) {
      throw new Error('terminal_handle_stale')
    }
  }
}
