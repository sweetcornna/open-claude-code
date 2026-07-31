import { BROWSER_TOOLS } from '@ant/claude-for-chrome-mcp'
import { join } from 'path'
import {
  getIsInteractive,
  getIsNonInteractiveSession,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { isInBundledMode } from '../bundledMode.js'
import { distRoot } from '../distRoot.js'
import { getGlobalConfig, saveGlobalConfig } from '../config.js'
import { logForDebugging } from '../debug.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../envUtils.js'
import { getPlatform } from '../platform.js'
import {
  CLAUDE_IN_CHROME_MCP_SERVER_NAME,
  getAllBrowserDataPaths,
} from './common.js'
import { getChromeSystemPrompt } from './prompt.js'
import { isChromeExtensionInstalledPortable } from './setupPortable.js'

export const CHROME_NATIVE_HOST_ISOLATION_ERROR =
  'Claude in Chrome native-host integration is unavailable in open-claude-code because installing it would overwrite the official Claude Code browser host. Use the browser bridge when available, or run without --chrome.'

export function shouldEnableClaudeInChrome(chromeFlag?: boolean): boolean {
  // Disable by default in non-interactive sessions (e.g., SDK, CI)
  if (getIsNonInteractiveSession() && chromeFlag !== true) {
    return false
  }

  // Check CLI flags
  if (chromeFlag === true) {
    return true
  }
  if (chromeFlag === false) {
    return false
  }

  // Check environment variables
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }

  // Check default config settings
  const config = getGlobalConfig()
  if (config.claudeInChromeDefaultEnabled !== undefined) {
    return config.claudeInChromeDefaultEnabled
  }

  return false
}

let shouldAutoEnable: boolean | undefined

export function shouldAutoEnableClaudeInChrome(): boolean {
  if (shouldAutoEnable !== undefined) {
    return shouldAutoEnable
  }

  if (!isChromeBrowserBridgeAvailable()) {
    shouldAutoEnable = false
    return shouldAutoEnable
  }

  shouldAutoEnable =
    getIsInteractive() &&
    isChromeExtensionInstalled_CACHED_MAY_BE_STALE() &&
    (process.env.USER_TYPE === 'ant' ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_chrome_auto_enable', false))

  return shouldAutoEnable
}

export function isChromeBrowserBridgeAvailable(): boolean {
  return false
}

/**
 * Setup Claude in Chrome MCP server and tools
 *
 * @returns MCP config and allowed tools, or throws if no isolated bridge is available
 */
export function setupClaudeInChrome(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  if (!isChromeBrowserBridgeAvailable()) {
    throw new Error(CHROME_NATIVE_HOST_ISOLATION_ERROR)
  }

  const isNativeBuild = isInBundledMode()
  const allowedTools = BROWSER_TOOLS.map(
    tool => `mcp__claude-in-chrome__${tool.name}`,
  )

  const env: Record<string, string> = {}
  if (getSessionBypassPermissionsMode()) {
    env.CLAUDE_CHROME_PERMISSION_MODE = 'skip_all_permission_checks'
  }
  const hasEnv = Object.keys(env).length > 0

  if (isNativeBuild) {
    return {
      mcpConfig: {
        [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
          type: 'stdio' as const,
          command: process.execPath,
          args: ['--claude-in-chrome-mcp'],
          scope: 'dynamic' as const,
          ...(hasEnv && { env }),
        },
      },
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  } else {
    const cliPath = join(distRoot, 'cli.js')

    const mcpConfig = {
      [CLAUDE_IN_CHROME_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: process.execPath,
        args: [`${cliPath}`, '--claude-in-chrome-mcp'],
        scope: 'dynamic' as const,
        ...(hasEnv && { env }),
      },
    }

    return {
      mcpConfig,
      allowedTools,
      systemPrompt: getChromeSystemPrompt(),
    }
  }
}

/**
 * Native-host installation intentionally has no implementation. The only host
 * identity supported by the bundled extension belongs to official Claude Code,
 * so open-claude-code must never write its manifest or Windows registry key.
 */
export async function installChromeNativeHostManifest(
  _manifestBinaryPath: string,
): Promise<void> {
  throw new Error(CHROME_NATIVE_HOST_ISOLATION_ERROR)
}

/**
 * Get cached value of whether Chrome extension is installed. Returns
 * from disk cache immediately, updates cache in background.
 *
 * Use this for sync/startup-critical paths where blocking on filesystem
 * access is not acceptable. The value may be stale if the cache hasn't
 * been updated recently.
 *
 * Only positive detections are persisted. A negative result from the
 * filesystem scan is not cached, because it may come from a machine that
 * shares ~/.claude.json but has no local Chrome (e.g. a remote dev
 * environment using the bridge), and caching it would permanently poison
 * auto-enable for every session on every machine that reads that config.
 */
function isChromeExtensionInstalled_CACHED_MAY_BE_STALE(): boolean {
  // Update cache in background without blocking
  void isChromeExtensionInstalled().then(isInstalled => {
    // Only persist positive detections — see docstring. The cost of a stale
    // `true` is one silent MCP connection attempt per session; the cost of a
    // stale `false` is auto-enable never working again without manual repair.
    if (!isInstalled) {
      return
    }
    const config = getGlobalConfig()
    if (config.cachedChromeExtensionInstalled !== isInstalled) {
      saveGlobalConfig(prev => ({
        ...prev,
        cachedChromeExtensionInstalled: isInstalled,
      }))
    }
  })

  // Return cached value immediately from disk
  const cached = getGlobalConfig().cachedChromeExtensionInstalled
  return cached ?? false
}

/**
 * Detects if the Claude in Chrome extension is installed by checking the Extensions
 * directory across all supported Chromium-based browsers and their profiles.
 *
 * @returns Object with isInstalled boolean and the browser where the extension was found
 */
export async function isChromeExtensionInstalled(): Promise<boolean> {
  const browserPaths = getAllBrowserDataPaths()
  if (browserPaths.length === 0) {
    logForDebugging(
      `[Claude in Chrome] Unsupported platform for extension detection: ${getPlatform()}`,
    )
    return false
  }
  return isChromeExtensionInstalledPortable(browserPaths, logForDebugging)
}
