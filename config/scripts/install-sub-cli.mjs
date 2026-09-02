#!/usr/bin/env node

import path from 'node:path'
import { installSubCli as installSubCliCore } from './install-sub-cli-core.mjs'

const scriptPath = import.meta.filename
const scriptDir = import.meta.dirname
const defaultSource = path.join(scriptDir, 'orca-sub.mjs')

export function installSubCli(options = {}) {
  return installSubCliCore({
    ...options,
    source: options.source ?? defaultSource
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  if (process.platform === 'win32' && process.argv.includes('--build-hook')) {
    console.log('[orca-sub] Skipping global registration during Windows build. Run pnpm run orca-sub:install explicitly.')
    process.exit(0)
  }

  const result = installSubCli()
  if (result.status === 'installed') {
    console.log(`[orca-sub] Installed ${result.commandPath} → ${defaultSource}`)
  } else if (result.status === 'already-installed') {
    console.log(`[orca-sub] ${result.commandPath} already points to the local subagent CLI.`)
  } else if (result.status === 'conflict') {
    console.warn(
      `[orca-sub] ${result.commandPath} already exists and is not this checkout's subagent CLI; left unchanged.`
    )
  }
}
