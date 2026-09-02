import { lstatSync, mkdtempSync, readFileSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { installSubCli } from './install-sub-cli-core.mjs'

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8')
)

describe('installSubCli', () => {
  it.skipIf(process.platform === 'win32')('creates a user-local orca-sub symlink to the wrapper and makes the wrapper executable', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    writeFileSync(source, '#!/usr/bin/env node\n', { mode: 0o644 })

    const result = installSubCli({ source, installDir })
    const commandPath = path.join(installDir, 'orca-sub')

    expect(result).toEqual({ status: 'installed', commandPath })
    expect(lstatSync(commandPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(commandPath)).toBe(source)
    expect(lstatSync(source).mode & 0o111).not.toBe(0)
  })

  it('creates a portable Windows cmd wrapper with a clone-scoped profile', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'npm bin')
    const source = path.join(root, 'clone with space', 'orca-sub.mjs')
    mkdirSync(path.dirname(source), { recursive: true })
    writeFileSync(source, '#!/usr/bin/env node\n')

    const result = installSubCli({
      source,
      installDir,
      platform: 'win32',
      environment: { APPDATA: path.join(root, 'appdata') }
    })
    const commandPath = path.join(installDir, 'orca-sub.cmd')

    expect(result).toEqual({ status: 'installed', commandPath })
    const wrapper = readFileSync(commandPath, 'utf8')
    expect(wrapper).toContain(`node "${source}" %*`)
    expect(wrapper).toMatch(/set "ORCA_USER_DATA_PATH=.*orca-sub[\\/]profiles[\\/][0-9a-f]{12}"/i)
    expect(wrapper).toMatch(/set "ORCA_DEV_USER_DATA_PATH=.*orca-sub[\\/]profiles[\\/][0-9a-f]{12}"/i)
  })

  it('escapes percent signs in Windows cmd paths', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-%repo%'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    writeFileSync(source, '#!/usr/bin/env node\n')

    installSubCli({
      source,
      installDir,
      platform: 'win32',
      environment: { APPDATA: path.join(root, '%appdata%') }
    })

    const wrapper = readFileSync(path.join(installDir, 'orca-sub.cmd'), 'utf8')
    expect(wrapper).toContain(source.replaceAll('%', '%%'))
    expect(wrapper).toContain(path.join(root, '%appdata%').replaceAll('%', '%%'))
  })

  it('trims surrounding whitespace from Windows APPDATA before deriving the profile', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    const appData = path.join(root, 'appdata')
    writeFileSync(source, '#!/usr/bin/env node\n')

    installSubCli({
      source,
      installDir,
      platform: 'win32',
      environment: { APPDATA: `  ${appData}  ` }
    })

    const wrapper = readFileSync(path.join(installDir, 'orca-sub.cmd'), 'utf8')
    expect(wrapper).toContain(appData)
    expect(wrapper).not.toContain(` ${path.sep}orca-sub`)
  })

  it('is idempotent for our Windows wrapper', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    const environment = { APPDATA: path.join(root, 'appdata') }
    writeFileSync(source, '#!/usr/bin/env node\n')

    installSubCli({ source, installDir, platform: 'win32', environment })
    expect(installSubCli({ source, installDir, platform: 'win32', environment })).toEqual({
      status: 'already-installed',
      commandPath: path.join(installDir, 'orca-sub.cmd')
    })
  })

  it('targets the checkout that performed registration with a distinct profile', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDirA = path.join(root, 'bin-a')
    const installDirB = path.join(root, 'bin-b')
    const sourceA = path.join(root, 'clone-a', 'config', 'scripts', 'orca-sub.mjs')
    const sourceB = path.join(root, 'clone-b', 'config', 'scripts', 'orca-sub.mjs')
    const environment = { APPDATA: path.join(root, 'appdata') }
    mkdirSync(path.dirname(sourceA), { recursive: true })
    mkdirSync(path.dirname(sourceB), { recursive: true })
    writeFileSync(sourceA, '#!/usr/bin/env node\n')
    writeFileSync(sourceB, '#!/usr/bin/env node\n')

    installSubCli({ source: sourceA, installDir: installDirA, platform: 'win32', environment })
    installSubCli({ source: sourceB, installDir: installDirB, platform: 'win32', environment })

    const wrapperA = readFileSync(path.join(installDirA, 'orca-sub.cmd'), 'utf8')
    const wrapperB = readFileSync(path.join(installDirB, 'orca-sub.cmd'), 'utf8')
    expect(wrapperA).toContain(sourceA)
    expect(wrapperA).not.toContain(sourceB)
    expect(wrapperB).toContain(sourceB)
    expect(wrapperB).not.toContain(sourceA)

    const profileA = wrapperA.match(/ORCA_DEV_USER_DATA_PATH=([^"\r\n]+)/)?.[1]
    const profileB = wrapperB.match(/ORCA_DEV_USER_DATA_PATH=([^"\r\n]+)/)?.[1]
    expect(profileA).toBeTruthy()
    expect(profileB).toBeTruthy()
    expect(profileA).not.toBe(profileB)
  })

  it('honors a test-only install directory from the environment', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'isolated-bin')
    const source = path.join(root, 'orca-sub.mjs')
    writeFileSync(source, '#!/usr/bin/env node\n')

    const result = installSubCli({
      source,
      platform: 'win32',
      environment: {
        ORCA_SUB_INSTALL_DIR: installDir,
        APPDATA: path.join(root, 'appdata')
      }
    })

    expect(result).toEqual({
      status: 'installed',
      commandPath: path.join(installDir, 'orca-sub.cmd')
    })
  })

  it('separates Windows build from explicit registration', () => {
    expect(packageJson.scripts['orca-sub:install']).toBe('node config/scripts/install-sub-cli.mjs')
    expect(packageJson.scripts['build:cli']).toContain('node config/scripts/install-sub-cli.mjs --build-hook')
  })

  it('does not overwrite unrelated Windows commands', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'orca-sub-install-'))
    const installDir = path.join(root, 'bin')
    const source = path.join(root, 'orca-sub.mjs')
    mkdirSync(installDir, { recursive: true })
    writeFileSync(source, '#!/usr/bin/env node\n')
    writeFileSync(path.join(installDir, 'orca-sub.cmd'), 'foreign')

    expect(installSubCli({
      source,
      installDir,
      platform: 'win32',
      environment: { APPDATA: path.join(root, 'appdata') }
    })).toEqual({
      status: 'conflict',
      commandPath: path.join(installDir, 'orca-sub.cmd')
    })
  })
})
