/**
 * `occ update` — Check and install the latest published version.
 *
 * Detection strategy:
 *  1. If `bun` is available and the current installation was done via bun → use `bun update -g`
 *  2. Otherwise → use `npm install -g`
 *
 * Both halves — the `npm view` version check and the `install -g` — go to
 * whichever registry `resolveUpdateRegistry` picked for this process; see
 * src/services/autoUpdate/updateRegistry.ts for why and for the integrity
 * gate that has to pass before a raced mirror is allowed to install anything.
 */
import { BIN_NAME, NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import chalk from 'chalk'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  approveRegistryForInstall,
  getSessionUpdateRegistry,
  registryCliArgs,
} from '../services/autoUpdate/updateRegistry.js'
import { packageManagerSpawnOptions } from '../utils/process/packageManager.js'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { whichSync } from '../utils/process/which.js'
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
  // `which` does not exist on Windows and `2>/dev/null` is not cmd.exe syntax,
  // so the old shell-out always threw there and reported every command as
  // missing — which sent the whole update path down the wrong branch.
  // whichSync uses where.exe on Windows and Bun.which when available.
  return whichSync(cmd) !== null
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
 * Ceiling for the `npm view` version check.
 *
 * This was 10 s, which was not a budget so much as a coin flip: a cold
 * `npm view` on the network this whole registry-racing change exists for
 * measured 8.85 s — 88% of the allowance — and npm does its own retries on top
 * (fetch-retries defaults to 2, with a 10 s minimum backoff), so a 10 s
 * ceiling truncated npm's first retry before it could help. When it tripped,
 * `getLatestOccVersion` returned null, the updater read that as "no update
 * available", and the only evidence was one logForDebugging line.
 *
 * 30 s is picked to be clear of both the measurement and npm's first retry.
 * It is not larger because the interactive `occ update` blocks the user on
 * this call and beyond roughly half a minute it reads as hung; the background
 * loop can afford it either way, since its timers are unref'd and the child is
 * bound to the shutdown signal. Note this ceiling now mostly governs the
 * fallback path: through a raced mirror the same check measured 0.356 s
 * against 2.95 s direct.
 */
const VERSION_CHECK_TIMEOUT_MS = 30_000

/**
 * Get the latest version from npm registry.
 *
 * `signal` lets the caller cancel the spawn — the background updater passes a
 * shutdown signal so Ctrl+C is not held hostage by an in-flight `npm view`.
 *
 * `registry` redirects this one invocation only; nothing is written to the
 * user's npm configuration.
 */
export async function getLatestOccVersion(
  signal?: AbortSignal,
  registry?: string,
): Promise<string | null> {
  const { signal: combined, cleanup } = createCombinedAbortSignal(signal, {
    timeoutMs: VERSION_CHECK_TIMEOUT_MS,
  })
  try {
    const result = await execFileNoThrowWithCwd(
      'npm',
      [
        'view',
        `${PACKAGE_NAME}@latest`,
        'version',
        '--prefer-online',
        ...registryCliArgs(registry),
      ],
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

/**
 * Ceiling for the interactive install.
 *
 * Also raised from 120 s, and for a measured reason: a real
 * `bun install -g @sweetcornna/open-claude-code@2.38.1` on the slow path took
 * 347.93 s wall (0.19 s user / 0.42 s sys — all of it network). The old cap
 * killed that install just under a third of the way through and reported it as
 * a failure. Racing registries usually makes this moot, but the fallback path
 * is precisely the one where the old ceiling was wrong.
 */
const INSTALL_TIMEOUT_MS = 600_000

/**
 * Shared by the interactive `occ update` path below and the background
 * installer (src/services/autoUpdate/occInstaller.ts) so the two can
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

  // Pick the registry before the version check, so both halves benefit.
  const choice = await getSessionUpdateRegistry({
    probeVersion: currentVersion,
  })
  if (choice.source === 'raced') {
    writeToStdout(`Fastest registry: ${choice.registry}\n`)
  }

  // Get latest version
  const latestVersion = await getLatestOccVersion(undefined, choice.registry)
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

  // A raced mirror is a third party occ picked on the user's behalf, so it has
  // to prove it serves the same artifact npm published before it is allowed to
  // install anything. On any doubt this returns the official registry.
  const registry = await approveRegistryForInstall({
    choice,
    version: latestVersion,
  })
  if (choice.source === 'raced' && registry !== choice.registry) {
    writeToStdout(
      chalk.yellow(
        `Integrity check did not pass for ${choice.registry}; installing from the official registry instead.`,
      ) + '\n',
    )
  }
  writeToStdout(`Installing update via ${pkgManager}...\n`)

  try {
    // Argument array, not a shell string. The registry URL reaching this line
    // came from npmrc / bunfig / the environment, so it is not occ's to trust;
    // isSafeRegistryUrl screens it, but not going through a shell in the first
    // place is the part that does not depend on getting a regex right. On
    // Windows packageManagerSpawnOptions still needs shell:true, because npm
    // and bun are .cmd shims there and CreateProcess cannot run a batch file —
    // which is exactly why the screening stays.
    const result = spawnSync(
      pkgManager,
      ['install', '-g', ...registryCliArgs(registry), latestPackageSpec()],
      {
        stdio: 'inherit',
        cwd: homedir(),
        timeout: INSTALL_TIMEOUT_MS,
        ...packageManagerSpawnOptions(),
      },
    )
    if (result.error) throw result.error
    if (result.status !== 0) {
      throw new Error(
        `${pkgManager} install -g exited with ${result.status ?? result.signal}`,
      )
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
