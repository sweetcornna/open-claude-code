import { execa } from 'execa'
import { readFile, realpath } from 'fs/promises'
import { BIN_NAME, NPM_PACKAGE_NAME } from 'src/constants/brand.js'
import { occConfigPath } from 'src/config/paths.js'
import { join, posix, win32 } from 'path'
import { checkGlobalInstallPermissions } from './autoUpdater.js'
import { isInBundledMode } from './bundledMode.js'
import {
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getGlobalConfig,
  type InstallMethod,
} from './config.js'
import { getCwd } from './cwd.js'
import { isEnvTruthy } from './envUtils.js'
import { execFileNoThrow } from './execFileNoThrow.js'
import { getFsImplementation } from './fsOperations.js'
import {
  isRunningFromLocalInstallation,
  localInstallationExists,
} from './localInstaller.js'
import {
  detectApk,
  detectAsdf,
  detectDeb,
  detectHomebrew,
  detectMise,
  detectPacman,
  detectRpm,
  detectWinget,
  getPackageManager,
} from './nativeInstaller/packageManagers.js'
import { getPlatform } from './platform.js'
import { getRipgrepStatus } from './ripgrep.js'
import { SandboxManager } from './sandbox/sandbox-adapter.js'
import { getManagedFilePath } from './settings/managedPath.js'
import { CUSTOMIZATION_SURFACES } from './settings/types.js'
import { jsonParse } from './slowOperations.js'
import { which } from './which.js'

export type InstallationType =
  | 'npm-global'
  | 'npm-local'
  | 'package-manager'
  | 'development'
  | 'unknown'

export type DiagnosticInfo = {
  installationType: InstallationType
  version: string
  installationPath: string
  invokedBinary: string
  configInstallMethod: InstallMethod | 'not set'
  autoUpdates: string
  hasUpdatePermissions: boolean | null
  multipleInstallations: Array<{ type: string; path: string }>
  warnings: Array<{ issue: string; fix: string }>
  recommendation?: string
  packageManager?: string
  ripgrepStatus: {
    working: boolean
    mode: 'system' | 'builtin' | 'embedded'
    systemPath: string | null
    note: string | null
  }
}

function getNormalizedPaths(): [invokedPath: string, execPath: string] {
  let invokedPath = process.argv[1] || ''
  let execPath = process.execPath || process.argv[0] || ''

  // On Windows, convert backslashes to forward slashes for consistent path matching
  if (getPlatform() === 'windows') {
    invokedPath = invokedPath.split(win32.sep).join(posix.sep)
    execPath = execPath.split(win32.sep).join(posix.sep)
  }

  return [invokedPath, execPath]
}

export async function getCurrentInstallationType(): Promise<InstallationType> {
  if (process.env.NODE_ENV === 'development') {
    return 'development'
  }

  const [invokedPath] = getNormalizedPaths()

  // Check if running in bundled mode first
  if (isInBundledMode()) {
    // Check if this bundled instance was installed by a package manager
    if (
      detectHomebrew() ||
      detectWinget() ||
      detectMise() ||
      detectAsdf() ||
      (await detectPacman()) ||
      (await detectDeb()) ||
      (await detectRpm()) ||
      (await detectApk())
    ) {
      return 'package-manager'
    }
    return 'unknown'
  }

  // Check if running from local npm installation
  if (isRunningFromLocalInstallation()) {
    return 'npm-local'
  }

  // Check if we're in a typical npm global location
  const npmGlobalPaths = [
    '/usr/local/lib/node_modules',
    '/usr/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/.nvm/versions/node/', // nvm installations
  ]

  if (npmGlobalPaths.some(path => invokedPath.includes(path))) {
    return 'npm-global'
  }

  // Also check for npm/nvm in the path even if not in standard locations
  if (invokedPath.includes('/npm/') || invokedPath.includes('/nvm/')) {
    return 'npm-global'
  }

  const npmConfigResult = await execa('npm config get prefix', {
    shell: true,
    reject: false,
  })
  const globalPrefix =
    npmConfigResult.exitCode === 0 ? npmConfigResult.stdout.trim() : null

  if (globalPrefix && invokedPath.startsWith(globalPrefix)) {
    return 'npm-global'
  }

  // If we can't determine, return unknown
  return 'unknown'
}

async function getInstallationPath(): Promise<string> {
  if (process.env.NODE_ENV === 'development') {
    return getCwd()
  }

  // For bundled/native builds, show the binary location
  if (isInBundledMode()) {
    // Try to find the actual binary that was invoked
    try {
      return await realpath(process.execPath)
    } catch {
      // This function doesn't expect errors
    }

    try {
      const path = await which(BIN_NAME)
      if (path) {
        return path
      }
    } catch {
      // This function doesn't expect errors
    }

    return 'bundled'
  }

  // For npm installations, use the path of the executable
  try {
    return process.argv[0] || 'unknown'
  } catch {
    return 'unknown'
  }
}

export function getInvokedBinary(): string {
  try {
    // For bundled/compiled executables, show the actual binary path
    if (isInBundledMode()) {
      return process.execPath || 'unknown'
    }

    // For npm/development, show the script path
    return process.argv[1] || 'unknown'
  } catch {
    return 'unknown'
  }
}

async function detectMultipleInstallations(): Promise<
  Array<{ type: string; path: string }>
> {
  const fs = getFsImplementation()
  const installations: Array<{ type: string; path: string }> = []

  // Check for local installation
  const localPath = occConfigPath('local')
  if (await localInstallationExists()) {
    installations.push({ type: 'npm-local', path: localPath })
  }

  // Check for global npm installation
  const npmResult = await execFileNoThrow('npm', [
    '-g',
    'config',
    'get',
    'prefix',
  ])
  if (npmResult.code === 0 && npmResult.stdout) {
    const npmPrefix = npmResult.stdout.trim()
    const isWindows = getPlatform() === 'windows'

    // First check for active installations via the occ binary.
    // Linux / macOS have prefix/bin/occ and prefix/lib/node_modules.
    // Windows has prefix/occ and prefix/node_modules.
    const globalBinPath = isWindows
      ? join(npmPrefix, BIN_NAME)
      : join(npmPrefix, 'bin', BIN_NAME)

    let globalBinExists = false
    try {
      await fs.stat(globalBinPath)
      globalBinExists = true
    } catch {
      // Not found
    }

    if (globalBinExists) {
      // Check if this is actually a Homebrew cask installation, not npm-global.
      // A Homebrew-managed npm prefix can place both kinds of executable in
      // /opt/homebrew/bin, so resolve the symlink before classifying it.
      let isCurrentHomebrewInstallation = false

      try {
        // Resolve the symlink to get the actual target
        const realPath = await realpath(globalBinPath)

        // If the symlink points to a Caskroom directory, it's a Homebrew cask
        // Only skip it if it's the same Homebrew installation we're currently running from
        if (realPath.includes('/Caskroom/')) {
          isCurrentHomebrewInstallation = detectHomebrew()
        }
      } catch {
        // If we can't resolve the symlink, include it anyway
      }

      if (!isCurrentHomebrewInstallation) {
        installations.push({ type: 'npm-global', path: globalBinPath })
      }
    } else {
      // If no occ binary exists, check only for an orphaned occ package.
      const globalPackagePath = isWindows
        ? join(npmPrefix, 'node_modules', NPM_PACKAGE_NAME)
        : join(npmPrefix, 'lib', 'node_modules', NPM_PACKAGE_NAME)

      try {
        await fs.stat(globalPackagePath)
        installations.push({
          type: 'npm-global-orphan',
          path: globalPackagePath,
        })
      } catch {
        // Package not found
      }
    }
  }

  return installations
}

async function detectConfigurationIssues(
  type: InstallationType,
): Promise<Array<{ issue: string; fix: string }>> {
  const warnings: Array<{ issue: string; fix: string }> = []

  // Managed-settings forwards-compat: the schema preprocess silently drops
  // unknown strictPluginOnlyCustomization surface names so one future enum
  // value doesn't null out the entire policy file (settings.ts:101). But
  // admins should KNOW — read the raw file and diff. Runs before the
  // development-mode early return: this is config correctness, not an
  // install-path check, and it's useful to see during dev testing.
  try {
    const raw = await readFile(
      join(getManagedFilePath(), 'managed-settings.json'),
      'utf-8',
    )
    const parsed: unknown = jsonParse(raw)
    const field =
      parsed && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>).strictPluginOnlyCustomization
        : undefined
    if (field !== undefined && typeof field !== 'boolean') {
      if (!Array.isArray(field)) {
        // .catch(undefined) in the schema silently drops this, so the rest
        // of managed settings survive — but the admin typed something
        // wrong (an object, a string, etc.).
        warnings.push({
          issue: `managed-settings.json: strictPluginOnlyCustomization has an invalid value (expected true or an array, got ${typeof field})`,
          fix: `The field is silently ignored (schema .catch rescues it). Set it to true, or an array of: ${CUSTOMIZATION_SURFACES.join(', ')}.`,
        })
      } else {
        const unknown = field.filter(
          x =>
            typeof x === 'string' &&
            !(CUSTOMIZATION_SURFACES as readonly string[]).includes(x),
        )
        if (unknown.length > 0) {
          warnings.push({
            issue: `managed-settings.json: strictPluginOnlyCustomization has ${unknown.length} value(s) this client doesn't recognize: ${unknown.map(String).join(', ')}`,
            fix: `These are silently ignored (forwards-compat). Known surfaces for this version: ${CUSTOMIZATION_SURFACES.join(', ')}. Either remove them, or this client is older than the managed-settings intended.`,
          })
        }
      }
    }
  } catch {
    // ENOENT (no managed settings) / parse error — not this check's concern.
    // Parse errors are surfaced by the settings loader itself.
  }

  const config = getGlobalConfig()

  // Skip most warnings for development mode
  if (type === 'development') {
    return warnings
  }

  // Check for configuration mismatches
  // Skip these checks if DISABLE_INSTALLATION_CHECKS is set (e.g., in HFI)
  if (
    !isEnvTruthy(process.env.DISABLE_INSTALLATION_CHECKS) &&
    type === 'npm-local' &&
    config.installMethod !== 'local'
  ) {
    warnings.push({
      issue: `Running from local installation but config install method is '${config.installMethod}'`,
      fix: `Run ${BIN_NAME} update or install ${NPM_PACKAGE_NAME} globally with npm or Bun`,
    })
  }

  if (type === 'npm-global' && (await localInstallationExists())) {
    warnings.push({
      issue: 'Local occ installation exists but is not being used',
      fix: `Run ${BIN_NAME} update to keep the active global installation current`,
    })
  }

  if (type === 'npm-local' && !(await which(BIN_NAME))) {
    warnings.push({
      issue: `Local installation is not accessible as ${BIN_NAME}`,
      fix: `Install ${NPM_PACKAGE_NAME} globally with npm or Bun`,
    })
  }

  return warnings
}

export function detectLinuxGlobPatternWarnings(): Array<{
  issue: string
  fix: string
}> {
  if (getPlatform() !== 'linux') {
    return []
  }

  const warnings: Array<{ issue: string; fix: string }> = []
  const globPatterns = SandboxManager.getLinuxGlobPatternWarnings()

  if (globPatterns.length > 0) {
    // Show first 3 patterns, then indicate if there are more
    const displayPatterns = globPatterns.slice(0, 3).join(', ')
    const remaining = globPatterns.length - 3
    const patternList =
      remaining > 0 ? `${displayPatterns} (${remaining} more)` : displayPatterns

    warnings.push({
      issue: `Glob patterns in sandbox permission rules are not fully supported on Linux`,
      fix: `Found ${globPatterns.length} pattern(s): ${patternList}. On Linux, glob patterns in Edit/Read rules will be ignored.`,
    })
  }

  return warnings
}

export async function getDoctorDiagnostic(): Promise<DiagnosticInfo> {
  const installationType = await getCurrentInstallationType()
  const version =
    typeof MACRO !== 'undefined' && MACRO.VERSION ? MACRO.VERSION : 'unknown'
  const installationPath = await getInstallationPath()
  const invokedBinary = getInvokedBinary()
  const multipleInstallations = await detectMultipleInstallations()
  const warnings = await detectConfigurationIssues(installationType)

  // Add glob pattern warnings for Linux sandboxing
  warnings.push(...detectLinuxGlobPatternWarnings())

  const config = getGlobalConfig()

  // Get config values for display
  const configInstallMethod = config.installMethod || 'not set'

  // Check permissions for global installations
  let hasUpdatePermissions: boolean | null = null
  if (installationType === 'npm-global') {
    const permCheck = await checkGlobalInstallPermissions()
    hasUpdatePermissions = permCheck.hasPermissions

    // Add warning if no permissions
    if (!hasUpdatePermissions && !getAutoUpdaterDisabledReason()) {
      warnings.push({
        issue: 'Insufficient permissions for auto-updates',
        fix: `Re-install Node.js without sudo, or run ${BIN_NAME} update from an account that can update ${NPM_PACKAGE_NAME}`,
      })
    }
  }

  // Get ripgrep status and configuration
  const ripgrepStatusRaw = getRipgrepStatus()

  // Provide simple ripgrep status info
  const ripgrepStatus = {
    working: ripgrepStatusRaw.working ?? true, // Assume working if not yet tested
    mode: ripgrepStatusRaw.mode,
    systemPath:
      ripgrepStatusRaw.mode === 'system' ? ripgrepStatusRaw.path : null,
    note: ripgrepStatusRaw.note ?? null,
  }

  // Get package manager info if running from package manager
  const packageManager =
    installationType === 'package-manager'
      ? await getPackageManager()
      : undefined

  const diagnostic: DiagnosticInfo = {
    installationType,
    version,
    installationPath,
    invokedBinary,
    configInstallMethod,
    autoUpdates: (() => {
      const reason = getAutoUpdaterDisabledReason()
      return reason
        ? `disabled (${formatAutoUpdaterDisabledReason(reason)})`
        : 'enabled'
    })(),
    hasUpdatePermissions,
    multipleInstallations,
    warnings,
    packageManager,
    ripgrepStatus,
  }

  return diagnostic
}
