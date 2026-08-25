import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const callMock = vi.fn()
vi.mock('../format', () => ({ printResult: vi.fn() }))

import { ORCHESTRATION_HANDLERS } from './orchestration'

let tempDir: string | undefined

afterEach(async () => {
  callMock.mockReset()
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true })
    tempDir = undefined
  }
})

describe('orchestration plan CLI handlers', () => {
  it('loads a structured plan file and creates the durable Run', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'orca-plan-cli-'))
    const planPath = join(tempDir, 'plan.json')
    const plan = {
      objective: 'CLI plan',
      maxConcurrency: 2,
      tasks: [{ key: 'a', spec: 'work A' }]
    }
    await writeFile(planPath, JSON.stringify(plan), 'utf8')
    callMock.mockResolvedValue({
      result: { run: { id: 'run_plan', objective: 'CLI plan' }, tasksByKey: {}, maxConcurrency: 2 }
    })

    await ORCHESTRATION_HANDLERS['orchestration plan-create']({
      flags: new Map([['file', 'plan.json']]),
      client: { call: callMock },
      cwd: tempDir,
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith('orchestration.planCreate', plan)
  })

  it('keeps the client timeout above an explicit long plan wait', async () => {
    callMock.mockResolvedValue({ result: { runId: 'run_plan', state: 'completed' } })

    await ORCHESTRATION_HANDLERS['orchestration plan-run']({
      flags: new Map([
        ['run', 'run_plan'],
        ['wait-timeout-ms', '90000000']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.planRun',
      { run: 'run_plan', waitTimeoutMs: 90_000_000 },
      { timeoutMs: 90_010_000 }
    )
  })

  it('runs or resumes a durable plan with a long-lived client timeout', async () => {
    callMock.mockResolvedValue({ result: { runId: 'run_plan', state: 'completed' } })

    await ORCHESTRATION_HANDLERS['orchestration plan-run']({
      flags: new Map([
        ['run', 'run_plan'],
        ['wait-timeout-ms', '5000']
      ]),
      client: { call: callMock },
      cwd: '/tmp/repo',
      json: true
    } as never)

    expect(callMock).toHaveBeenCalledWith(
      'orchestration.planRun',
      { run: 'run_plan', waitTimeoutMs: 5000 },
      { timeoutMs: 86_400_000 }
    )
  })
})
