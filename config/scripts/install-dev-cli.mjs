#!/usr/bin/env node
// Installs the orca-dev wrapper on PATH after `pnpm run build:cli`.
// Prefer the traditional global location, but fall back to the user-local bin
// so unprivileged development checkouts work without sudo.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const scriptDir = import.meta.dirname
const source = path.join(scriptDir, 'orca-dev.mjs')

const commandPaths =
  process.platform === 'darwin' || process.platform === 'linux'
    ? ['/usr/local/bin/orca-dev', path.join(homedir(), '.local', 'bin', 'orca-dev')]
    : []

if (commandPaths.length === 0) {
  console.log('[orca-dev] Skipping CLI symlink (unsupported platform).')
  process.exit(0)
}

function pathEntryExists(target) {
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function isOwnedByUs(target) {
  try {
    if (!lstatSync(target).isSymbolicLink()) {
      return false
    }
    return readlinkSync(target) === source
  } catch {
    return false
  }
}

for (const commandPath of commandPaths) {
  if (pathEntryExists(commandPath)) {
    if (isOwnedByUs(commandPath)) {
      console.log(`[orca-dev] ${commandPath} already points to dev CLI.`)
      process.exit(0)
    }
    console.warn(`[orca-dev] ${commandPath} exists and is not Orca's dev CLI; trying fallback.`)
    continue
  }

  try {
    mkdirSync(path.dirname(commandPath), { recursive: true })
    symlinkSync(source, commandPath)
    console.log(`[orca-dev] Symlinked ${commandPath} → ${source}`)
    process.exit(0)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      console.log(`[orca-dev] Cannot write ${commandPath}; trying fallback.`)
      continue
    }
    throw error
  }
}

console.log(
  '[orca-dev] Could not install an orca-dev command on PATH. Run the wrapper directly:\n' +
    `  ${source}`
)
