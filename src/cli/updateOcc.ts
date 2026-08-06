/**
 * `occ update` — Check and install the latest published version.
 *
 * Detection strategy:
 *  1. If `bun` is available and the current installation was done via bun → use `bun update -g`
 *  2. Otherwise → use `npm install -g`
 */
import { BIN_NAME, NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import chalk from 'chalk'
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { distRoot } from '../utils/filesystem/distRoot.js'
import { createCombinedAbortSignal } from '../utils/process/combinedAbortSignal.js'
import { execFileNoThrowWithCwd } from '../utils/process/execFileNoThrow.js'
import { gracefulShutdown } from '../utils/process/gracefulShutdown.js'
import { writeToStdout } from '../utils/process/process.js'
// Shared Bun.semver-backed comparison. A hand-rolled numeric compare used to
// live here and ignored prerelease tags, so `2.11.0-beta.1 >= 2.11.0` was true
// and prerelease users were permanently pinned at "already up to date".
import { gte } from '../utils/text/semver.js'

const PACKAGE_NAME = NPM_PACKAGE_NAME

export function getCurrentOccVersion(): string {
  // Read version from the nearest package.json (walks up from dist root)
  try {
    const pkgPath = join(distRoot, '..', 'package.json')
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
      if (pkg.version) return pkg.version
    }
  } catch {
    // fallback
  }
  return MACRO.VERSION
}

function isCommandAvailable(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

/**
 * Detect whether the current installation was done via bun.
 * Checks if the binary path contains "bun" or if bun's global install dir has our package.
 */
function isBunInstallation(): boolean {
  // Check if the running binary is under bun's global install path
  const execPath = process.execPath
  if (execPath.includes('bun')) {
    return true
  }

  // Check bun's global install directory
  const bunGlobalDir = join(homedir(), '.bun', 'install', 'global')
  if (existsSync(join(bunGlobalDir, 'node_modules', PACKAGE_NAME))) {
    return true
  }

  return false
}

/**
 * Strict variant of `isBunInstallation()` for the background auto-updater:
 * the *running* entrypoint must resolve into bun's global install tree.
 *
 * `isBunInstallation()` is deliberately loose (execPath contains "bun", or
 * the package merely exists in bun's global dir) because `occ update` is
 * explicit user intent. A background update must never fire from a source
 * checkout run with `bun run dev` — which also satisfies both loose checks —
 * so this one only trusts the script path actually living under the tree
 * that `bun install -g` owns.
 */
export function isRunningFromBunGlobalInstall(): boolean {
  const bunGlobalRoot = join(homedir(), '.bun', 'install', 'global')
  const invoked = process.argv[1]
  if (!invoked) {
    return false
  }
  try {
    // ~/.bun/bin/<bin> is a symlink into the global tree; resolve it.
    return realpathSync(invoked).startsWith(bunGlobalRoot)
  } catch {
    return invoked.startsWith(bunGlobalRoot)
  }
}

/**
 * Get the latest version from npm registry.
 *
 * `signal` lets the caller cancel the spawn — the background updater passes a
 * shutdown signal so Ctrl+C is not held hostage by an in-flight `npm view`.
 */
export async function getLatestOccVersion(
  signal?: AbortSignal,
): Promise<string | null> {
  const { signal: combined, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: 10_000,
  })
  try {
    const result = await execFileNoThrowWithCwd(
      'npm',
      ['view', `${PACKAGE_NAME}@latest`, 'version', '--prefer-online'],
      { abortSignal: combined, cwd: homedir() },
    )
    if (result.code !== 0) {
      logForDebugging(`npm view failed: ${result.stderr}`)
      return null
    }
    return result.stdout.trim()
  } finally {
    cleanup()
  }
}

const INSTALL_TIMEOUT_MS = 120_000

/**
 * Shared by the interactive `occ update` path below and the deferred background
 * installer (src/services/autoUpdate/deferredOccInstall.ts) so the two can
 * never drift to different package specs. Both resolve to NPM_PACKAGE_NAME and
 * nothing else — src/cli/__tests__/updateIsolation.test.ts pins that.
 */
export function latestPackageSpec(): string {
  return `${PACKAGE_NAME}@latest`
}

export async function updateOcc(): Promise<void> {
  const currentVersion = getCurrentOccVersion()
  writeToStdout(`Current version: ${currentVersion}\n`)

  // Determine package manager
  const hasBun = isCommandAvailable('bun')
  const useBun = isBunInstallation()
  const pkgManager = useBun && hasBun ? 'bun' : 'npm'

  writeToStdout(`Package manager: ${pkgManager}\n`)
  writeToStdout('Checking for updates...\n')

  // Get latest version
  const latestVersion = await getLatestOccVersion()
  if (!latestVersion) {
    process.stderr.write(chalk.red('Failed to check for updates') + '\n')
    process.stderr.write('Unable to fetch latest version from npm registry.\n')
    await gracefulShutdown(1)
    return
  }

  // Already up to date?
  if (latestVersion === currentVersion || gte(currentVersion, latestVersion)) {
    writeToStdout(
      chalk.green(`${BIN_NAME} is up to date (${currentVersion})`) + '\n',
    )
    await gracefulShutdown(0)
    return
  }

  writeToStdout(
    `New version available: ${latestVersion} (current: ${currentVersion})\n`,
  )
  writeToStdout(`Installing update via ${pkgManager}...\n`)

  try {
    if (pkgManager === 'bun') {
      execSync(`bun install -g ${latestPackageSpec()}`, {
        stdio: 'inherit',
        cwd: homedir(),
        timeout: INSTALL_TIMEOUT_MS,
      })
    } else {
      execSync(`npm install -g ${latestPackageSpec()}`, {
        stdio: 'inherit',
        cwd: homedir(),
        timeout: INSTALL_TIMEOUT_MS,
      })
    }

    writeToStdout(
      chalk.green(
        `Successfully updated from ${currentVersion} to ${latestVersion}`,
      ) + '\n',
    )
  } catch (error) {
    process.stderr.write(chalk.red('Update failed') + '\n')
    process.stderr.write(`${error}\n`)
    process.stderr.write('\n')
    process.stderr.write('Try manually updating with:\n')
    if (pkgManager === 'bun') {
      process.stderr.write(
        chalk.bold(`  bun install -g ${PACKAGE_NAME}@latest`) + '\n',
      )
    } else {
      process.stderr.write(
        chalk.bold(`  npm install -g ${PACKAGE_NAME}@latest`) + '\n',
      )
    }
    await gracefulShutdown(1)
  }

  await gracefulShutdown(0)
}
