/**
 * Wiring for browser-use (https://github.com/browser-use/browser-use) as occ's
 * browser integration.
 *
 * browser-use ships an MCP server that drives a real Chrome/Chromium and
 * exposes semantic actions (`browser_extract_content`, an autonomous
 * `retry_with_browser_use_agent`) rather than the raw DevTools surface. It is a
 * Python tool launched through `uvx`, so unlike an npm dependency occ cannot
 * guarantee it is present; `--chrome` checks for `uvx` up front and says so.
 */
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import { getGlobalConfig } from '../config/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../config/envUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { BROWSER_USE_UVX_SPEC, isBrowserUseAvailable } from './provision.js'
export { isBrowserUseAvailable }

import {
  BROWSER_USE_MCP_SERVER_NAME,
  BROWSER_USE_READ_ONLY_TOOLS,
} from './common.js'
import { getBrowserUseSystemPrompt } from './prompt.js'

/**
 * Should the browser server be attached to this session?
 *
 * Precedence, highest first: the explicit `--chrome` / `--no-chrome` flag, the
 * `CLAUDE_CODE_ENABLE_CFC` environment variable, the persisted default in
 * global config. Off otherwise, and off in non-interactive sessions (SDK, CI,
 * headless `-p` runs) unless `--chrome` was passed explicitly — driving a
 * browser in CI is never what someone meant by inheriting a default.
 *
 * The flag keeps its `--chrome` spelling: it is what users have in their
 * shell aliases and docs, and it still means "give me the browser".
 */
export function shouldEnableBrowserTool(browserFlag?: boolean): boolean {
  if (getIsNonInteractiveSession() && browserFlag !== true) {
    return false
  }
  if (browserFlag !== undefined) {
    return browserFlag
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }
  const config = getGlobalConfig()
  // The old key is still read: renaming a persisted setting silently resets
  // it for everyone who had it on.
  return (
    config.browserToolDefaultEnabled ??
    config.chromeDevtoolsDefaultEnabled ??
    false
  )
}

/**
 * MCP config, pre-approved tool names, and system prompt for browser-use.
 *
 */
export function setupBrowserUse(authEnv: Record<string, string> = {}): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  return {
    mcpConfig: {
      [BROWSER_USE_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command: 'uvx',
        args: ['--from', BROWSER_USE_UVX_SPEC, 'browser-use', '--mcp'],
        scope: 'dynamic' as const,
        // browser-use makes its own model calls, so it needs credentials of its
        // own. See browserUseAuthEnv: an API key already in the environment is
        // inherited untouched; an OAuth login has no key to inherit, so the
        // access token is passed as ANTHROPIC_AUTH_TOKEN instead.
        env: authEnv,
      },
    },
    // Only the observational tools skip the prompt. Everything that can act on
    // the page is left to the normal MCP permission flow.
    allowedTools: BROWSER_USE_READ_ONLY_TOOLS.map(name =>
      buildMcpToolName(BROWSER_USE_MCP_SERVER_NAME, name),
    ),
    systemPrompt: getBrowserUseSystemPrompt(),
  }
}
