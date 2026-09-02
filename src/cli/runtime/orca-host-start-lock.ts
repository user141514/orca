import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { RuntimeClientError } from './types'

const DEFAULT_WAIT_TIMEOUT_MS = 90_000
const DEFAULT_POLL_MS = 50
const INCOMPLETE_OWNER_GRACE_MS = 5_000

type LockOwner = {
  pid: number
  token: string
}

type CliLockOptions = {
  lockHome: string
  lockName: string
  waitTimeoutMs?: number
  pollMs?: number
}

type HostStartLockOptions = {
  lockHome?: string
  waitTimeoutMs?: number
  pollMs?: number
}

export function withOrcaHostStartLock<T>(
  run: () => Promise<T>,
  options: HostStartLockOptions = {}
): Promise<T> {
  const lockHome =
    options.lockHome ??
    process.env.ORCA_HOST_START_LOCK_HOME?.trim() ??
    path.join(homedir(), '.orca-host-start-lock')
  return withOrcaCliLock(run, {
    lockHome,
    lockName: 'start.lock',
    waitTimeoutMs: options.waitTimeoutMs,
    pollMs: options.pollMs
  })
}

export async function withOrcaCliLock<T>(
  run: () => Promise<T>,
  options: CliLockOptions
): Promise<T> {
  const lockDir = path.join(options.lockHome, options.lockName)
  const ownerPath = path.join(lockDir, 'owner.json')
  const token = randomUUID()
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + waitTimeoutMs

  await mkdir(options.lockHome, { recursive: true })
  for (;;) {
    if (await tryAcquire(lockDir, ownerPath, token)) {
      break
    }
    if (Date.now() >= deadline) {
      throw new RuntimeClientError(
        'runtime_start_lock_timeout',
        `Timed out waiting for the Orca CLI lock at ${lockDir}.`
      )
    }
    await delay(pollMs)
  }

  try {
    return await run()
  } finally {
    await releaseIfOwned(lockDir, ownerPath, token)
  }
}

async function tryAcquire(lockDir: string, ownerPath: string, token: string): Promise<boolean> {
  try {
    await mkdir(lockDir)
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      throw error
    }
    const staleOwner = await getStaleOwner(lockDir, ownerPath)
    if (staleOwner) {
      await removeStaleLockIfUnchanged(lockDir, ownerPath, staleOwner)
    }
    return false
  }

  try {
    await writeFile(ownerPath, JSON.stringify({ pid: process.pid, token } satisfies LockOwner), 'utf8')
    return true
  } catch (error) {
    await rm(lockDir, { recursive: true, force: true })
    throw error
  }
}

async function getStaleOwner(lockDir: string, ownerPath: string): Promise<LockOwner | null> {
  const owner = await readOwner(ownerPath)
  if (owner) {
    return isProcessAlive(owner.pid) ? null : owner
  }

  try {
    const stats = await stat(lockDir)
    if (Date.now() - stats.mtimeMs >= INCOMPLETE_OWNER_GRACE_MS) {
      return { pid: -1, token: '' }
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error
    }
  }
  return null
}

async function removeStaleLockIfUnchanged(
  lockDir: string,
  ownerPath: string,
  staleOwner: LockOwner
): Promise<void> {
  const current = await readOwner(ownerPath)
  if (staleOwner.token) {
    if (!current || current.token !== staleOwner.token || current.pid !== staleOwner.pid) {
      return
    }
  } else if (current) {
    return
  }
  await rm(lockDir, { recursive: true, force: true })
}

async function releaseIfOwned(lockDir: string, ownerPath: string, token: string): Promise<void> {
  const owner = await readOwner(ownerPath)
  if (owner?.token === token && owner.pid === process.pid) {
    await rm(lockDir, { recursive: true, force: true })
  }
}

async function readOwner(ownerPath: string): Promise<LockOwner | null> {
  try {
    const value: unknown = JSON.parse(await readFile(ownerPath, 'utf8'))
    if (!value || typeof value !== 'object') {
      return null
    }
    const owner = value as Record<string, unknown>
    if (!Number.isInteger(owner.pid) || typeof owner.token !== 'string') {
      return null
    }
    return { pid: Number(owner.pid), token: owner.token }
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) {
      return null
    }
    throw error
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return isErrno(error, 'EPERM')
  }
}

function isErrno(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
