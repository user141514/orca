export type CollaborationStep = {
  key: string
  instruction: string
}

export type CollaborationPlan = {
  objective: string
  steps: CollaborationStep[]
}

export type CollaborationRunReceipt = {
  runId: string
}
