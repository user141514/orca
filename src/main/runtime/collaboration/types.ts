export type CollaborationStepAdmission = {
  acceptedTypes: string[]
  minPriority: 'normal' | 'high' | 'urgent'
}

export type CollaborationStep = {
  key: string
  instruction: string
  dependsOn?: string[]
  contextFrom?: string[]
  publishesTo?: string[]
  requiredPublishesTo?: string[]
  subscribesTo?: string[]
  admission?: CollaborationStepAdmission
}

export type CollaborationPlan = {
  objective: string
  maxConcurrency: number
  steps: CollaborationStep[]
}

export type CollaborationRunReceipt = {
  runId: string
}
