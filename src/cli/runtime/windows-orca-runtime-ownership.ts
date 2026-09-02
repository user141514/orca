import { RuntimeClientError } from './types'
import { readWindowsProcessTableFresh, type WindowsProcessRow } from './windows-process-table'
import { terminateWindowsProcessTree } from './windows-process-tree-kill'
export { withOrcaHostStartLock } from './orca-host-start-lock'

const ORCA_REPLACEMENT_QUIESCENCE_TIMEOUT_MS = 5_000
const ORCA_REPLACEMENT_POLL_MS = 50

function commandExecutable(command: string): string {
  const trimmed = command.trim()
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const closingQuote = trimmed.indexOf(trimmed[0], 1)
    return closingQuote === -1 ? trimmed.slice(1) : trimmed.slice(1, closingQuote)
  }
  return trimmed.split(/\s+/, 1)[0] ?? ''
}

function hasOrcaDevRunnerAncestor(
  row: WindowsProcessRow,
  rowsByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  let current: WindowsProcessRow | undefined = row
  for (let depth = 0; current && depth < 32; depth += 1) {
    if (
      /[\\/]config[\\/]scripts[\\/]run-electron-vite-dev\.mjs(?:\s|"|$)/i.test(
        current.command
      )
    ) {
      return true
    }
    current = rowsByPid.get(current.ppid)
  }
  return false
}

function isOrcaRuntimeProcess(
  row: WindowsProcessRow,
  rowsByPid: ReadonlyMap<number, WindowsProcessRow>
): boolean {
  if (row.pid === process.pid) {
    return false
  }
  const name = row.name.toLowerCase()
  if (name === 'electron.exe') {
    return (
      /--annotation=_productName=orca(?:\s|$)/i.test(row.command) ||
      hasOrcaDevRunnerAncestor(row, rowsByPid)
    )
  }
  if (name !== 'orca.exe') {
    return false
  }
  const executable = commandExecutable(row.command)
  if (/[\\/]resources[\\/]bin[\\/]orca\.exe$/i.test(executable)) {
    return false
  }
  return !/(?:app\.asar\.unpacked[\\/])?out[\\/]cli[\\/]index\.js/i.test(row.command)
}

function collectProcessTreePids(
  rows: WindowsProcessRow[],
  rootPid: number | null | undefined
): Set<number> {
  if (!rootPid) {
    return new Set()
  }
  const childrenByParent = new Map<number, number[]>()
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? []
    children.push(row.pid)
    childrenByParent.set(row.ppid, children)
  }
  const result = new Set<number>([rootPid])
  const stack = [...(childrenByParent.get(rootPid) ?? [])]
  while (stack.length > 0) {
    const pid = stack.pop()!
    if (result.has(pid)) {
      continue
    }
    result.add(pid)
    stack.push(...(childrenByParent.get(pid) ?? []))
  }
  return result
}

function getReplaceableOrcaRuntimeRows(
  rows: WindowsProcessRow[],
  preservePid?: number | null
): WindowsProcessRow[] {
  const rowsByPid = new Map(rows.map((row) => [row.pid, row]))
  const preservedPids = collectProcessTreePids(rows, preservePid)
  return rows.filter(
    (row) => !preservedPids.has(row.pid) && isOrcaRuntimeProcess(row, rowsByPid)
  )
}

function getOrcaRuntimeRoots(
  rows: WindowsProcessRow[],
  preservePid?: number | null
): WindowsProcessRow[] {
  const runtimeRows = getReplaceableOrcaRuntimeRows(rows, preservePid)
  const runtimePids = new Set(runtimeRows.map((row) => row.pid))
  return runtimeRows.filter((row) => !runtimePids.has(row.ppid))
}

export async function reconcileWindowsOrcaRuntimes(
  options: { preservePid?: number | null } = {}
): Promise<void> {
  if (process.platform !== 'win32') {
    return
  }
  const initial = await readWindowsProcessTableFresh()
  for (const root of getOrcaRuntimeRoots(initial, options.preservePid)) {
    await terminateWindowsProcessTree(root.pid)
  }

  const deadline = Date.now() + ORCA_REPLACEMENT_QUIESCENCE_TIMEOUT_MS
  for (;;) {
    const rows = await readWindowsProcessTableFresh()
    const remaining = getReplaceableOrcaRuntimeRows(rows, options.preservePid)
    if (remaining.length === 0) {
      return
    }
    if (Date.now() >= deadline) {
      throw new RuntimeClientError(
        'runtime_replace_timeout',
        `Timed out waiting for existing Orca processes to exit: ${remaining.map((row) => row.pid).join(', ')}`
      )
    }
    await new Promise<void>((resolve) => setTimeout(resolve, ORCA_REPLACEMENT_POLL_MS))
  }
}
