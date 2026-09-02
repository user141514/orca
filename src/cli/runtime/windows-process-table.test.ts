import { describe, expect, it } from 'vitest'
import { parseWindowsProcessRowsJson } from './windows-process-table'

describe('parseWindowsProcessRowsJson', () => {
  it('normalizes PowerShell CIM JSON rows', () => {
    expect(
      parseWindowsProcessRowsJson(
        JSON.stringify([
          { pid: 10, ppid: 1, name: 'Orca.exe', command: '"C:\\Orca\\Orca.exe" --user-data-dir=C:\\profile' },
          { pid: 11, ppid: 10, name: 'electron.exe', command: null }
        ])
      )
    ).toEqual([
      { pid: 10, ppid: 1, name: 'Orca.exe', command: '"C:\\Orca\\Orca.exe" --user-data-dir=C:\\profile' },
      { pid: 11, ppid: 10, name: 'electron.exe', command: '' }
    ])
  })

  it('accepts the single-object shape emitted by ConvertTo-Json for one row', () => {
    expect(
      parseWindowsProcessRowsJson(JSON.stringify({ pid: 22, ppid: 2, name: 'Orca.exe', command: 'orca' }))
    ).toEqual([{ pid: 22, ppid: 2, name: 'Orca.exe', command: 'orca' }])
  })
})
