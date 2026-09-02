import { createHash } from 'node:crypto'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function installSubCli({
  source,
  installDir,
  platform = process.platform,
  environment = process.env
} = {}) {
  if (!source) {
    throw new Error('installSubCli requires a source path.')
  }

  const environmentInstallDir = environment.ORCA_SUB_INSTALL_DIR?.trim()
  const resolvedInstallDir =
    installDir ?? (environmentInstallDir || getDefaultInstallDir(platform, environment))

  if (platform === 'win32') {
    return installWindowsSubCli(source, resolvedInstallDir, environment)
  }

  const commandPath = path.join(resolvedInstallDir, 'orca-sub')
  makeExecutable(source)
  mkdirSync(resolvedInstallDir, { recursive: true })

  const existing = readExistingEntry(commandPath)
  if (existing) {
    if (existing.kind === 'symlink' && sameSymlinkTarget(commandPath, existing.target, source)) {
      return { status: 'already-installed', commandPath }
    }
    return { status: 'conflict', commandPath }
  }

  symlinkSync(source, commandPath)
  return { status: 'installed', commandPath }
}

function getDefaultInstallDir(platform, environment) {
  if (platform === 'win32') {
    return path.join(
      environment.APPDATA ?? path.join(homedir(), 'AppData', 'Roaming'),
      'npm'
    )
  }
  return path.join(homedir(), '.local', 'bin')
}

function installWindowsSubCli(source, installDir, environment) {
  const commandPath = path.join(installDir, 'orca-sub.cmd')
  const userDataPath = getWindowsUserDataPath(source, environment)
  const wrapper = renderWindowsSubCliWrapper(source, userDataPath)
  mkdirSync(installDir, { recursive: true })

  const existing = readExistingWindowsWrapper(commandPath)
  if (existing !== null) {
    return existing === wrapper
      ? { status: 'already-installed', commandPath }
      : { status: 'conflict', commandPath }
  }

  writeFileSync(commandPath, wrapper, 'utf8')
  return { status: 'installed', commandPath }
}

function getWindowsUserDataPath(source, environment) {
  const appData = environment.APPDATA?.trim() || path.join(homedir(), 'AppData', 'Roaming')
  const normalizedSource = path.win32.normalize(source).toLowerCase()
  const checkoutId = createHash('sha256').update(normalizedSource).digest('hex').slice(0, 12)
  return path.join(appData, 'orca-sub', 'profiles', checkoutId)
}

function renderWindowsSubCliWrapper(source, userDataPath) {
  const escapedSource = source.replaceAll('%', '%%')
  const escapedUserDataPath = userDataPath.replaceAll('%', '%%')
  return `@echo off\r\nset "ORCA_USER_DATA_PATH=${escapedUserDataPath}"\r\nset "ORCA_DEV_USER_DATA_PATH=${escapedUserDataPath}"\r\nnode "${escapedSource}" %*\r\n`
}

function readExistingWindowsWrapper(commandPath) {
  try {
    return readFileSync(commandPath, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function makeExecutable(source) {
  const mode = statSync(source).mode
  if ((mode & 0o111) === 0) {
    chmodSync(source, mode | 0o111)
  }
}

function readExistingEntry(commandPath) {
  try {
    const stats = lstatSync(commandPath)
    return stats.isSymbolicLink()
      ? { kind: 'symlink', target: readlinkSync(commandPath) }
      : { kind: 'other' }
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function sameSymlinkTarget(commandPath, target, source) {
  return path.resolve(path.dirname(commandPath), target) === path.resolve(source)
}
