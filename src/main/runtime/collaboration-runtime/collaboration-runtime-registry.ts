import type { OrcaRuntimeService } from '../orca-runtime'
import type { CollaborationRuntimeSession } from '../collaboration/collaboration-runtime-session'

const sessionsByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, CollaborationRuntimeSession>
>()

export function registerCollaborationRuntimeSession(
  runtime: OrcaRuntimeService,
  runId: string,
  session: CollaborationRuntimeSession
): void {
  const sessions = sessionsByRuntime.get(runtime) ?? new Map<string, CollaborationRuntimeSession>()
  if (sessions.has(runId)) {
    throw new Error(`Collaboration runtime session already registered: ${runId}`)
  }
  sessions.set(runId, session)
  sessionsByRuntime.set(runtime, sessions)
}

export function getCollaborationRuntimeSession(
  runtime: OrcaRuntimeService,
  runId: string
): CollaborationRuntimeSession | undefined {
  return sessionsByRuntime.get(runtime)?.get(runId)
}

export function unregisterCollaborationRuntimeSession(
  runtime: OrcaRuntimeService,
  runId: string
): void {
  const sessions = sessionsByRuntime.get(runtime)
  if (!sessions) {
    return
  }
  sessions.delete(runId)
  if (sessions.size === 0) {
    sessionsByRuntime.delete(runtime)
  }
}
