import path from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

export type WindowsTreeKiller = (rootPid: number) => Promise<void>

const WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS = 5_000

export async function terminateWindowsProcessTree(
  rootPid: number,
  deps: { runProcessImpl?: typeof runProcess } = {}
): Promise<void> {
  if (!Number.isInteger(rootPid) || rootPid <= 0) {
    return
  }
  const run = deps.runProcessImpl ?? runProcess
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  try {
    await run({
      program: path.join(systemRoot, 'System32', 'taskkill.exe'),
      args: ['/pid', String(rootPid), '/T', '/F'],
      timeoutMs: WINDOWS_PROCESS_TREE_KILL_TIMEOUT_MS
    })
  } catch {
    // Why best effort: reconciliation verifies quiescence from a fresh process snapshot.
  }
}
