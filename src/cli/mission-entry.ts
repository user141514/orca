export function normalizeRootMissionArgs(argv: string[]): string[] {
  const mission = argv[0]?.trim()
  if (!mission || mission.startsWith('-') || !looksLikeMissionText(mission)) {
    return argv
  }
  return ['mission', 'start', '--text', mission, ...argv.slice(1)]
}

function looksLikeMissionText(value: string): boolean {
  return (
    /\s/u.test(value) ||
    Array.from(value).some((character) => (character.codePointAt(0) ?? 0) > 0x7f)
  )
}
