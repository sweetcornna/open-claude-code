/**
 * Protocol Handler Registration
 *
 * Registers the occ-owned custom URI scheme with the OS so links invoke
 * `occ --handle-uri <url>` without claiming the official handler identity.
 *
 * Platform details:
 *   macOS  — Creates a minimal .app trampoline in ~/Applications with
 *            CFBundleURLTypes in its Info.plist
 *   Linux  — Creates a .desktop file in $XDG_DATA_HOME/applications
 *            (default ~/.local/share/applications) and registers it with xdg-mime
 *   Windows — Writes registry keys under HKEY_CURRENT_USER\Software\Classes
 */

import { DEEP_LINK_PROTOCOL } from './parseDeepLink.js'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  BIN_NAME,
  DISPLAY_NAME,
  MACOS_DEEP_LINK_BUNDLE_ID,
} from 'src/constants/brand.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { logForDebugging } from '../telemetry/debug.js'
import { getClaudeConfigHomeDir } from '../config/envUtils.js'
import { getErrnoCode } from '../runtime/errors.js'
import { execFileNoThrow } from '../process/execFileNoThrow.js'
import { getInitialSettings } from '../settings/settings.js'
import { which } from '../process/which.js'
import { getUserBinDir, getXDGDataHome } from '../filesystem/xdg.js'

export const MACOS_BUNDLE_ID = MACOS_DEEP_LINK_BUNDLE_ID
const APP_NAME = `${DISPLAY_NAME} URL Handler`
const DESKTOP_FILE_NAME = 'open-claude-code-url-handler.desktop'
const MACOS_APP_NAME = `${DISPLAY_NAME} URL Handler.app`

// Shared between register* (writes these paths/values) and
// isProtocolHandlerCurrent (reads them back). Keep the writer and reader
// in lockstep — drift here means the check returns a perpetual false.
const MACOS_APP_DIR = path.join(os.homedir(), 'Applications', MACOS_APP_NAME)
const MACOS_SYMLINK_PATH = path.join(
  MACOS_APP_DIR,
  'Contents',
  'MacOS',
  BIN_NAME,
)
function linuxDesktopPath(): string {
  return path.join(getXDGDataHome(), 'applications', DESKTOP_FILE_NAME)
}
const WINDOWS_REG_KEY = `HKEY_CURRENT_USER\\Software\\Classes\\${DEEP_LINK_PROTOCOL}`
const WINDOWS_COMMAND_KEY = `${WINDOWS_REG_KEY}\\shell\\open\\command`

const FAILURE_BACKOFF_MS = 24 * 60 * 60 * 1000

function linuxExecLine(occPath: string): string {
  return `Exec="${occPath}" --handle-uri %u`
}
function windowsCommandValue(occPath: string): string {
  return `"${occPath}" --handle-uri "%1"`
}

/**
 * Register the protocol handler on macOS.
 *
 * Creates a .app bundle where the CFBundleExecutable is a symlink to the
 * already-installed occ executable. The URL-handler NAPI module reads the
 * Apple Event and dispatches it through the normal occ deep-link flow.
 *
 * This approach avoids shipping a separate executable (which would need
 * to be signed and allowlisted by endpoint security tools like Santa).
 */
async function registerMacos(occPath: string): Promise<void> {
  const contentsDir = path.join(MACOS_APP_DIR, 'Contents')

  // Remove any existing app bundle to start clean
  try {
    await fs.rm(MACOS_APP_DIR, { recursive: true })
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      throw e
    }
  }

  await fs.mkdir(path.dirname(MACOS_SYMLINK_PATH), { recursive: true })

  // Info.plist registers the occ-owned scheme and executable.
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key>
  <string>${MACOS_BUNDLE_ID}</string>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${BIN_NAME}</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>${DISPLAY_NAME} Deep Link</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${DEEP_LINK_PROTOCOL}</string>
      </array>
    </dict>
  </array>
</dict>
</plist>`

  await fs.writeFile(path.join(contentsDir, 'Info.plist'), infoPlist)

  // Symlink to the existing occ executable to avoid creating a second binary.
  // Written LAST among the throwing fs calls: isProtocolHandlerCurrent reads
  // this symlink, so it acts as the commit marker. If Info.plist write
  // failed above, no symlink → next session retries.
  await fs.symlink(occPath, MACOS_SYMLINK_PATH)

  // Re-register the app with LaunchServices so macOS picks up the URL scheme.
  const lsregister =
    '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
  await execFileNoThrow(lsregister, ['-R', MACOS_APP_DIR], { useCwd: false })

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler at ${MACOS_APP_DIR}`,
  )
}

/**
 * Register the protocol handler on Linux.
 * Creates a .desktop file and registers it with xdg-mime.
 */
async function registerLinux(occPath: string): Promise<void> {
  await fs.mkdir(path.dirname(linuxDesktopPath()), { recursive: true })

  const desktopEntry = `[Desktop Entry]
Name=${APP_NAME}
Comment=Handle ${DEEP_LINK_PROTOCOL}:// deep links for ${DISPLAY_NAME}
${linuxExecLine(occPath)}
Type=Application
NoDisplay=true
MimeType=x-scheme-handler/${DEEP_LINK_PROTOCOL};
`

  await fs.writeFile(linuxDesktopPath(), desktopEntry)

  // Register as the default handler for the scheme. On headless boxes
  // (WSL, Docker, CI) xdg-utils isn't installed — not a failure: there's
  // no desktop to click links from, and some apps read the .desktop
  // MimeType line directly. The artifact check still short-circuits
  // next session since the .desktop file is present.
  const xdgMime = await which('xdg-mime')
  if (xdgMime) {
    const { code } = await execFileNoThrow(
      xdgMime,
      ['default', DESKTOP_FILE_NAME, `x-scheme-handler/${DEEP_LINK_PROTOCOL}`],
      { useCwd: false },
    )
    if (code !== 0) {
      throw Object.assign(new Error(`xdg-mime exited with code ${code}`), {
        code: 'XDG_MIME_FAILED',
      })
    }
  }

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler at ${linuxDesktopPath()}`,
  )
}

/**
 * Register the protocol handler on Windows via the registry.
 */
async function registerWindows(occPath: string): Promise<void> {
  for (const args of [
    ['add', WINDOWS_REG_KEY, '/ve', '/d', `URL:${APP_NAME}`, '/f'],
    ['add', WINDOWS_REG_KEY, '/v', 'URL Protocol', '/d', '', '/f'],
    [
      'add',
      WINDOWS_COMMAND_KEY,
      '/ve',
      '/d',
      windowsCommandValue(occPath),
      '/f',
    ],
  ]) {
    const { code } = await execFileNoThrow('reg', args, { useCwd: false })
    if (code !== 0) {
      throw Object.assign(new Error(`reg add exited with code ${code}`), {
        code: 'REG_FAILED',
      })
    }
  }

  logForDebugging(
    `Registered ${DEEP_LINK_PROTOCOL}:// protocol handler in Windows registry`,
  )
}

/**
 * Register the occ-owned protocol handler with the operating system.
 */
export async function registerProtocolHandler(occPath?: string): Promise<void> {
  const resolved = occPath ?? (await resolveOccPath())

  switch (process.platform) {
    case 'darwin':
      await registerMacos(resolved)
      break
    case 'linux':
      await registerLinux(resolved)
      break
    case 'win32':
      await registerWindows(resolved)
      break
    default:
      throw new Error(`Unsupported platform: ${process.platform}`)
  }
}

/**
 * Resolve the occ executable path for protocol registration. Prefer the stable
 * user-bin location and fall back to the current executable.
 */
async function resolveOccPath(): Promise<string> {
  const binaryName = process.platform === 'win32' ? `${BIN_NAME}.exe` : BIN_NAME
  const stablePath = path.join(getUserBinDir(), binaryName)
  try {
    await fs.realpath(stablePath)
    return stablePath
  } catch {
    return process.execPath
  }
}

/**
 * Check whether the OS-level protocol handler is already registered AND
 * points at the expected occ executable. Reads the registration artifact
 * directly (symlink target, .desktop Exec line, registry value) rather than
 * a synced config flag, so:
 *   - the check is per-machine (config can sync across machines; OS state can't)
 *   - stale paths self-heal (install-method change → re-register next session)
 *   - deleted artifacts self-heal
 *
 * Any read error (ENOENT, EACCES, reg nonzero) → false → re-register.
 */
export async function isProtocolHandlerCurrent(
  occPath: string,
): Promise<boolean> {
  try {
    switch (process.platform) {
      case 'darwin': {
        const target = await fs.readlink(MACOS_SYMLINK_PATH)
        return target === occPath
      }
      case 'linux': {
        const content = await fs.readFile(linuxDesktopPath(), 'utf8')
        return content.includes(linuxExecLine(occPath))
      }
      case 'win32': {
        const { stdout, code } = await execFileNoThrow(
          'reg',
          ['query', WINDOWS_COMMAND_KEY, '/ve'],
          { useCwd: false },
        )
        return code === 0 && stdout.includes(windowsCommandValue(occPath))
      }
      default:
        return false
    }
  } catch {
    return false
  }
}

/**
 * Auto-register the occ-owned deep-link handler when missing or stale.
 * Runs every session from backgroundHousekeeping (fire-and-forget),
 * but the artifact check makes it a no-op after the first successful run
 * unless the install path moves or the OS artifact is deleted.
 */
export async function ensureDeepLinkProtocolRegistered(): Promise<void> {
  if (getInitialSettings().disableDeepLinkRegistration === 'disable') {
    return
  }
  if (!getFeatureValue_CACHED_MAY_BE_STALE('tengu_lodestone_enabled', false)) {
    return
  }

  const occPath = await resolveOccPath()
  if (await isProtocolHandlerCurrent(occPath)) {
    return
  }

  // EACCES/ENOSPC are deterministic — retrying next session won't help.
  // Throttle to once per 24h so a read-only ~/.local/share/applications
  // doesn't generate a failure event on every startup. The marker stays in
  // occ's per-machine config root.
  const failureMarkerPath = path.join(
    getClaudeConfigHomeDir(),
    '.deep-link-register-failed',
  )
  try {
    const stat = await fs.stat(failureMarkerPath)
    if (Date.now() - stat.mtimeMs < FAILURE_BACKOFF_MS) {
      return
    }
  } catch {
    // Marker absent — proceed.
  }

  try {
    await registerProtocolHandler(occPath)
    logEvent('tengu_deep_link_registered', { success: true })
    logForDebugging(
      `Auto-registered ${DEEP_LINK_PROTOCOL}:// deep link protocol handler`,
    )
    await fs.rm(failureMarkerPath, { force: true }).catch(() => {})
  } catch (error) {
    const code = getErrnoCode(error)
    logEvent('tengu_deep_link_registered', {
      success: false,
      error_code:
        code as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    logForDebugging(
      `Failed to auto-register deep link protocol handler: ${error instanceof Error ? error.message : String(error)}`,
      { level: 'warn' },
    )
    if (code === 'EACCES' || code === 'ENOSPC') {
      await fs.writeFile(failureMarkerPath, '').catch(() => {})
    }
  }
}
