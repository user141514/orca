import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { withOrcaHostStartLock } from './orca-host-start-lock'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = (): void => undefined
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('withOrcaHostStartLock', () => {
  it('serializes concurrent callers for the same host lock', async () => {
    const lockHome = path.join(mkdtempSync(path.join(tmpdir(), 'orca-host-lock-')), 'lock-home')
    const gate = deferred()
    const firstEntered = deferred()
    const order: string[] = []
    const options = { lockHome, waitTimeoutMs: 2_000, pollMs: 10 }

    const first = withOrcaHostStartLock(async () => {
      order.push('first-enter')
      firstEntered.resolve()
      await gate.promise
      order.push('first-exit')
    }, options)

    await firstEntered.promise
    const second = withOrcaHostStartLock(async () => {
      order.push('second-enter')
    }, options)

    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(order).toEqual(['first-enter'])

    gate.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(['first-enter', 'first-exit', 'second-enter'])
  })
})
