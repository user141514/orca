import type { CollaborationPlan } from '../collaboration/types'
import type { OrcaRuntimeService } from '../orca-runtime'

type TaskPublicationObligation = {
  requiredTopics: readonly string[]
  publishedTopics: Set<string>
}

type RunPublicationObligations = Map<string, TaskPublicationObligation>

const obligationsByRuntime = new WeakMap<
  OrcaRuntimeService,
  Map<string, RunPublicationObligations>
>()

export function registerCollaborationPublicationObligations(
  runtime: OrcaRuntimeService,
  runId: string,
  plan: CollaborationPlan,
  taskIdsByStepKey: Readonly<Record<string, string>>
): void {
  const runs = obligationsByRuntime.get(runtime) ?? new Map<string, RunPublicationObligations>()
  if (runs.has(runId)) {
    throw new Error(`Collaboration publication obligations already registered: ${runId}`)
  }

  const tasks: RunPublicationObligations = new Map()
  for (const step of plan.steps) {
    const requiredTopics = [...new Set(step.requiredPublishesTo ?? [])]
    if (requiredTopics.length === 0) {
      continue
    }
    const taskId = taskIdsByStepKey[step.key]
    if (!taskId) {
      throw new Error(`Missing task mapping for collaboration step: ${step.key}`)
    }
    tasks.set(taskId, { requiredTopics, publishedTopics: new Set() })
  }

  runs.set(runId, tasks)
  obligationsByRuntime.set(runtime, runs)
}

export function noteCollaborationPublication(
  runtime: OrcaRuntimeService,
  runId: string,
  taskId: string,
  topic: string
): void {
  const obligation = obligationsByRuntime.get(runtime)?.get(runId)?.get(taskId)
  if (!obligation || !obligation.requiredTopics.includes(topic)) {
    return
  }
  obligation.publishedTopics.add(topic)
}

export function getMissingCollaborationPublicationTopics(
  runtime: OrcaRuntimeService,
  runId: string,
  taskId: string
): string[] {
  const obligation = obligationsByRuntime.get(runtime)?.get(runId)?.get(taskId)
  if (!obligation) {
    return []
  }
  return obligation.requiredTopics.filter((topic) => !obligation.publishedTopics.has(topic))
}

export function unregisterCollaborationPublicationObligations(
  runtime: OrcaRuntimeService,
  runId: string
): void {
  const runs = obligationsByRuntime.get(runtime)
  if (!runs) {
    return
  }
  runs.delete(runId)
  if (runs.size === 0) {
    obligationsByRuntime.delete(runtime)
  }
}
