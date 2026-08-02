/**
 * Utilities for handling local installation
 */

import { BIN_NAME, NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import { occConfigPath } from 'src/config/paths.js'
import { access, chmod, writeFile } from 'fs/promises'
import { join, sep } from 'path'
import { type ReleaseChannel, saveGlobalConfig } from '../config/config.js'
import { getErrnoCode } from '../runtime/errors.js'
import { execFileNoThrowWithCwd } from '../process/execFileNoThrow.js'
import { getFsImplementation } from '../filesystem/fsOperations.js'
import { logError } from '../telemetry/log.js'
import { jsonStringify } from '../telemetry/slowOperations.js'

function getLocalInstallDir(): string {
  return occConfigPath('local')
}

export function getLocalOccPath(): string {
  return join(getLocalInstallDir(), BIN_NAME)
}

/**
 * Check if we're running from our managed local installation
 */
export function isRunningFromLocalInstallation(): boolean {
  const execPath = process.argv[1] || ''
  const localModulesPath = occConfigPath('local', 'node_modules')
  return (
    execPath === localModulesPath ||
    execPath.startsWith(`${localModulesPath}${sep}`)
  )
}

/**
 * Write `content` to `path` only if the file does not already exist.
 * Uses O_EXCL ('wx') for atomic create-if-missing.
 */
async function writeIfMissing(
  path: string,
  content: string,
  mode?: number,
): Promise<boolean> {
  try {
    await writeFile(path, content, { encoding: 'utf8', flag: 'wx', mode })
    return true
  } catch (e) {
    if (getErrnoCode(e) === 'EEXIST') return false
    throw e
  }
}

/**
 * Ensure the local package environment is set up
 * Creates the directory, package.json, and wrapper script
 */
export async function ensureLocalPackageEnvironment(): Promise<boolean> {
  try {
    const localInstallDir = getLocalInstallDir()

    // Create installation directory (recursive, idempotent)
    await getFsImplementation().mkdir(localInstallDir)

    // Create package.json if it doesn't exist
    await writeIfMissing(
      join(localInstallDir, 'package.json'),
      jsonStringify(
        { name: 'occ-local', version: '0.0.1', private: true },
        null,
        2,
      ),
    )

    // Create the wrapper script if it doesn't exist
    const wrapperPath = getLocalOccPath()
    const created = await writeIfMissing(
      wrapperPath,
      `#!/bin/sh\nexec "${localInstallDir}/node_modules/.bin/${BIN_NAME}" "$@"`,
      0o755,
    )
    if (created) {
      // Mode in writeFile is masked by umask; chmod to ensure executable bit.
      await chmod(wrapperPath, 0o755)
    }

    return true
  } catch (error) {
    logError(error)
    return false
  }
}

/**
 * Install or update the occ package in the local directory
 * @param channel - Release channel to use (latest or stable)
 * @param specificVersion - Optional specific version to install (overrides channel)
 */
export async function installOrUpdateOccPackage(
  channel: ReleaseChannel,
  specificVersion?: string | null,
): Promise<'in_progress' | 'success' | 'install_failed'> {
  try {
    // First ensure the environment is set up
    if (!(await ensureLocalPackageEnvironment())) {
      return 'install_failed'
    }

    // Use specific version if provided, otherwise use channel tag
    const versionSpec = specificVersion
      ? specificVersion
      : channel === 'stable'
        ? 'stable'
        : 'latest'
    const result = await execFileNoThrowWithCwd(
      'npm',
      ['install', `${NPM_PACKAGE_NAME}@${versionSpec}`],
      { cwd: getLocalInstallDir(), maxBuffer: 1000000 },
    )

    if (result.code !== 0) {
      const error = new Error(
        `Failed to install ${NPM_PACKAGE_NAME}: ${result.stderr}`,
      )
      logError(error)
      return result.code === 190 ? 'in_progress' : 'install_failed'
    }

    // Set installMethod to 'local' to prevent npm permission warnings
    saveGlobalConfig(current => ({
      ...current,
      installMethod: 'local',
    }))

    return 'success'
  } catch (error) {
    logError(error)
    return 'install_failed'
  }
}

/**
 * Check if local installation exists.
 * Pure existence probe — callers use this to choose update path / UI hints.
 */
export async function localInstallationExists(): Promise<boolean> {
  try {
    await access(join(getLocalInstallDir(), 'node_modules', '.bin', BIN_NAME))
    return true
  } catch {
    return false
  }
}

/**
 * Get shell type to determine appropriate path setup
 */
export function getShellType(): string {
  const shellPath = process.env.SHELL || ''
  if (shellPath.includes('zsh')) return 'zsh'
  if (shellPath.includes('bash')) return 'bash'
  if (shellPath.includes('fish')) return 'fish'
  return 'unknown'
}
