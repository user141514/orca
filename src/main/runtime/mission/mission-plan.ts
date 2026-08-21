import { z } from 'zod'

const MissionPlanTaskSchema = z.object({
  key: z.string().trim().min(1).max(128),
  spec: z.string().trim().min(1).max(32_768),
  deps: z.array(z.string().trim().min(1).max(128)).max(32).optional().default([])
})

const SingleAgentMissionPlanSchema = z.object({
  mode: z.literal('single-agent')
})

const OrchestrationMissionPlanSchema = z.object({
  mode: z.literal('orchestration'),
  objective: z.string().trim().min(1).max(32_768),
  maxConcurrency: z.number().int().min(1).max(32),
  tasks: z.array(MissionPlanTaskSchema).min(2).max(64)
})

const MissionPlanSchema = z.discriminatedUnion('mode', [
  SingleAgentMissionPlanSchema,
  OrchestrationMissionPlanSchema
])

export type MissionPlan = z.infer<typeof MissionPlanSchema>

export function buildMissionPlanningPrompt(mission: string): string {
  return [
    'You are Orca Mission Planner. Decide whether this mission should run as one agent or as a deterministic multi-agent DAG.',
    '',
    'Return JSON only. Do not use markdown fences or explanatory prose.',
    '',
    'Use {"mode":"single-agent"} when one agent can execute the mission coherently without meaningful parallel work.',
    'Use orchestration when the user explicitly requests multiple agents, parallel work, or when there are genuinely separable tasks that benefit from dependency-aware execution.',
    'Do not invent extra tasks merely to increase agent count.',
    'Do not choose execution backends, agents, worktrees, terminals, Dispatch IDs, capabilities, retries, or scheduling mechanics. Orca owns execution authority.',
    'Task specs must be self-contained instructions for the worker that will execute them.',
    'Never make a task instruction forbid Orca control-plane actions. worker_done, heartbeat, and ask are protocol actions and remain allowed and required even when the user says to only reply with specific content or do nothing else.',
    '',
    'Orchestration JSON shape:',
    '{"mode":"orchestration","objective":"...","maxConcurrency":2,"tasks":[{"key":"a","spec":"...","deps":[]},{"key":"b","spec":"...","deps":[]},{"key":"c","spec":"...","deps":["a","b"]}]}',
    '',
    'Mission:',
    mission
  ].join('\n')
}

export function parseMissionPlan(raw: string): MissionPlan {
  let decoded: unknown
  try {
    decoded = JSON.parse(stripMarkdownFence(raw))
  } catch {
    throw new Error('Mission planner returned invalid JSON.')
  }

  const parsed = MissionPlanSchema.safeParse(decoded)
  if (!parsed.success) {
    throw new Error(
      `Mission planner returned an invalid plan: ${parsed.error.issues[0]?.message ?? 'invalid plan'}`
    )
  }
  if (parsed.data.mode === 'single-agent') {
    return parsed.data
  }

  const keys = new Set<string>()
  for (const task of parsed.data.tasks) {
    if (keys.has(task.key)) {
      throw new Error(`Duplicate Mission plan task key: ${task.key}`)
    }
    keys.add(task.key)
  }
  for (const task of parsed.data.tasks) {
    for (const dependency of task.deps) {
      if (!keys.has(dependency)) {
        throw new Error(`Unknown Mission plan dependency: ${dependency}`)
      }
    }
  }
  return parsed.data
}

function stripMarkdownFence(raw: string): string {
  const trimmed = raw.trim()
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed)
  return match?.[1]?.trim() ?? trimmed
}
