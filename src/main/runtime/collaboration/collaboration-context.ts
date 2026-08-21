export type CollaborationContextEntry = {
  stepKey: string
  result: string
}

export function buildCollaborationStepInput(
  instruction: string,
  context: readonly CollaborationContextEntry[]
): string {
  if (context.length === 0) {
    return instruction
  }

  const sections = context.flatMap((entry, index) => [
    `[${entry.stepKey}]`,
    entry.result,
    ...(index === context.length - 1 ? [] : [''])
  ])
  return ['=== PREDECESSOR RESULTS ===', ...sections, '', '=== CURRENT STEP ===', instruction].join(
    '\n'
  )
}
