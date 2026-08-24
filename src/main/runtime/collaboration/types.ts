export type CollaborationStep = {
  key: string
  instruction: string
  dependsOn?: string[]
  contextFrom?: string[]
  subscribesTo?: string[]
}

export type CollaborationPlan = {
  objective: string
  maxConcurrency: number
  steps: CollaborationStep[]
}

export type CollaborationRunReceipt = {
  runId: string
}
