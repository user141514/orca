import path from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'

export type WindowsProcessRow = {
  pid: number
  ppid: number
  name: string
  command: string
}

const WINDOWS_PROCESS_SCAN_TIMEOUT_MS = 15_000
const WINDOWS_PROCESS_SCAN_MAX_BUFFER = 16 * 1024 * 1024
const WINDOWS_PROCESS_SCAN_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '@(Get-CimInstance Win32_Process | ForEach-Object {',
  "  [pscustomobject]@{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; name=[string]$_.Name; command=[string]$_.CommandLine }",
  '}) | ConvertTo-Json -Compress'
].join('; ')

export function parseWindowsProcessRowsJson(stdout: string): WindowsProcessRow[] {
  const text = stdout.trim()
  if (!text) {
    return []
  }

  const parsed: unknown = JSON.parse(text)
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.flatMap((value): WindowsProcessRow[] => {
    if (!value || typeof value !== 'object') {
      return []
    }
    const row = value as Record<string, unknown>
    const pid = Number(row.pid)
    const ppid = Number(row.ppid)
    const name = typeof row.name === 'string' ? row.name : ''
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !name) {
      return []
    }
    return [{
      pid,
      ppid,
      name,
      command: typeof row.command === 'string' ? row.command : ''
    }]
  })
}

export async function readWindowsProcessTableFresh(
  deps: { runProcessImpl?: typeof runProcess } = {}
): Promise<WindowsProcessRow[]> {
  const run = deps.runProcessImpl ?? runProcess
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows'
  const result = await run({
    program: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_PROCESS_SCAN_SCRIPT],
    timeoutMs: WINDOWS_PROCESS_SCAN_TIMEOUT_MS,
    maxOutputBytes: WINDOWS_PROCESS_SCAN_MAX_BUFFER
  })
  if (result.timedOut) {
    throw new Error('windows process table timed out')
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || `windows process table exited with code ${result.code}`)
  }
  return parseWindowsProcessRowsJson(result.stdout)
}
