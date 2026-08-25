import { afterEach, describe, expect, it, vi } from 'vitest'

const fsMock = vi.hoisted(() => ({
  existsSync: vi.fn(),
  lstatSync: vi.fn(),
  mkdirSync: vi.fn(),
  readlinkSync: vi.fn(),
  symlinkSync: vi.fn()
}))

vi.mock('node:fs', () => fsMock)
vi.mock('node:os', () => ({ homedir: () => '/home/test' }))

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
  for (const mock of Object.values(fsMock)) {
    mock.mockReset()
  }
})

describe('install-dev-cli', () => {
  it('skips a dangling global symlink and installs the fallback command', async () => {
    fsMock.existsSync.mockReturnValue(false)
    fsMock.lstatSync.mockImplementation((candidate: unknown) => {
      if (candidate === '/usr/local/bin/orca-dev') {
        return { isSymbolicLink: () => true }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })
    fsMock.readlinkSync.mockReturnValue('/missing/orca-dev.mjs')
    fsMock.symlinkSync.mockImplementation((_source: unknown, commandPath: unknown) => {
      if (commandPath === '/usr/local/bin/orca-dev') {
        throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' })
      }
    })
    vi.spyOn(process, 'exit').mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit:${String(code)}`)
    }) as never)

    await expect(import('./install-dev-cli.mjs')).rejects.toThrow('process.exit:0')
    expect(fsMock.symlinkSync).toHaveBeenCalledWith(
      expect.any(String),
      '/home/test/.local/bin/orca-dev'
    )
  })
})
