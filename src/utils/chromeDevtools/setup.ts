/**
 * Wiring for Google's `chrome-devtools-mcp` (Apache-2.0) as occ's browser
 * integration.
 *
 * This replaced an extension + native-messaging-host stack that occ could not
 * legally or safely own: the only host identity the bundled extension accepts
 * belongs to official Claude Code, so installing it would have hijacked the
 * other product's browser integration. That path was fail-closed and therefore
 * dead. A plain stdio MCP server has no shared identity with anything — it is
 * a subprocess occ spawns and talks to over stdin/stdout.
 *
 * The server is opt-in (`--chrome`) and its tools are permission-gated like
 * any other MCP server's, except for a strictly observational subset listed in
 * `CHROME_DEVTOOLS_READ_ONLY_TOOLS`.
 */
import { createRequire } from 'node:module'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { buildMcpToolName } from '../../services/mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../../services/mcp/types.js'
import { getGlobalConfig } from '../config/config.js'
import { logForDebugging } from '../telemetry/debug.js'
import { whichSync } from '../process/which.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../config/envUtils.js'
import {
  CHROME_AUTOCONNECT_ENV,
  CHROME_BROWSER_URL_ENV,
  CHROME_DEVTOOLS_MCP_SERVER_NAME,
  CHROME_DEVTOOLS_READ_ONLY_TOOLS,
} from './common.js'
import { getChromeDevtoolsSystemPrompt } from './prompt.js'

/**
 * The bin entry inside the dependency. Resolved as a subpath rather than via
 * the package `main`, because `main` is the library export — we need the
 * executable that speaks MCP over stdio. `chrome-devtools-mcp` ships no
 * `exports` map, so subpath resolution is well-defined.
 */
const CHROME_DEVTOOLS_BIN_SUBPATH =
  'chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js'

/** Version pulled if the bundled dependency cannot be resolved at runtime. */
const CHROME_DEVTOOLS_NPX_SPEC = 'chrome-devtools-mcp@latest'

/**
 * Should the Chrome DevTools server be attached to this session?
 *
 * Precedence, highest first: the explicit `--chrome` / `--no-chrome` flag, the
 * `CLAUDE_CODE_ENABLE_CFC` environment variable, the persisted default in
 * global config. Off otherwise, and off in non-interactive sessions (SDK, CI,
 * headless `-p` runs) unless `--chrome` was passed explicitly — spawning a
 * browser in CI is never what someone meant by inheriting a default.
 */
export function shouldEnableChromeDevtools(chromeFlag?: boolean): boolean {
  if (getIsNonInteractiveSession() && chromeFlag !== true) {
    return false
  }
  if (chromeFlag !== undefined) {
    return chromeFlag
  }
  if (isEnvTruthy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return true
  }
  if (isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_CFC)) {
    return false
  }
  return getGlobalConfig().chromeDevtoolsDefaultEnabled ?? false
}

/**
 * Interpreter for the resolved entry point.
 *
 * Under the shipped Node build, reuse the exact interpreter already running —
 * guaranteed present and version-matched. Under Bun (`occ-bun`), prefer `node`
 * by name: chrome-devtools-mcp pulls in puppeteer and is only tested on Node.
 *
 * But `occ-bun` is the entry point a Bun-only machine has to use — `occ` itself
 * is `#!/usr/bin/env node` — and `scripts/install.sh` installs with bun in
 * preference to npm, checking for Node only on the npm path. So "running under
 * Bun" does not imply Node exists, and naming it unconditionally turned
 * `--chrome` into `spawn node ENOENT` on exactly the machines that had no other
 * way to launch occ. Probe first, and fall back to the Bun binary already
 * running: an untested-but-working interpreter beats a server that cannot start.
 */
function resolveInterpreter(): string {
  if (!process.versions.bun) {
    return process.execPath
  }
  const node = whichSync('node')
  if (node) {
    return node
  }
  logForDebugging(
    `[chrome-devtools] No node on PATH; running the server under ${process.execPath} instead`,
  )
  return process.execPath
}

/**
 * Locate the server entry point.
 *
 * `chrome-devtools-mcp` is a runtime dependency, so in a normal install it
 * sits in `node_modules` next to the shipped `dist/`. `createRequire` walks up
 * from this module the same way Node would, which also covers hoisted and
 * nested layouts. If that fails — a partial install, a bundle copied without
 * its dependencies — fall back to a package runner, which costs a download on
 * first run but keeps the feature working instead of erroring out. `npx` is
 * itself part of a Node install, so the Bun-only case needs `bunx` here too.
 */
export function resolveChromeDevtoolsCommand(): {
  command: string
  args: string[]
  resolved: boolean
} {
  try {
    const entry = createRequire(import.meta.url).resolve(
      CHROME_DEVTOOLS_BIN_SUBPATH,
    )
    return { command: resolveInterpreter(), args: [entry], resolved: true }
  } catch (error) {
    // `-y` is npx's "don't prompt before installing"; bunx installs without
    // prompting and has no such flag, so passing it would reach the server as
    // an unknown argument.
    const useBunx = !whichSync('npx') && !!whichSync('bunx')
    logForDebugging(
      `[chrome-devtools] Could not resolve ${CHROME_DEVTOOLS_BIN_SUBPATH}, falling back to ${useBunx ? 'bunx' : 'npx'}: ${error}`,
    )
    return {
      command: useBunx ? 'bunx' : 'npx',
      args: useBunx
        ? [CHROME_DEVTOOLS_NPX_SPEC]
        : ['-y', CHROME_DEVTOOLS_NPX_SPEC],
      resolved: false,
    }
  }
}

/**
 * Build the connection arguments.
 *
 * Default is `--autoConnect`: attach to the Chrome the user already has open,
 * with their profile and their logins, rather than launching a blank browser
 * they would have to sign into again. Needs Chrome 144+ with remote debugging
 * enabled; `occ doctor` reports whether that holds.
 *
 * `OCC_CHROME_BROWSER_URL` switches to `--browserUrl`, which is how WSL and
 * remote setups work: Chrome runs on the host with `--remote-debugging-port`
 * and occ attaches over HTTP.
 */
export function buildChromeDevtoolsArgs(): string[] {
  const browserUrl = process.env[CHROME_BROWSER_URL_ENV]?.trim()
  const connection = browserUrl
    ? ['--browserUrl', browserUrl]
    : isEnvDefinedFalsy(process.env[CHROME_AUTOCONNECT_ENV])
      ? []
      : ['--autoConnect']

  return [
    ...connection,
    // occ does not forward third-party telemetry on the user's behalf. Both
    // are documented opt-outs; the env vars below cover the same ground for
    // the npx fallback, where our flags reach the same binary anyway.
    '--no-usage-statistics',
  ]
}

/**
 * MCP config, pre-approved tool names, and system prompt for the Chrome
 * DevTools server. Same shape the old extension-based setup returned, so the
 * call site in `main.tsx` is unchanged in structure.
 */
export function setupChromeDevtools(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
  systemPrompt: string
} {
  const { command, args: commandArgs } = resolveChromeDevtoolsCommand()

  return {
    mcpConfig: {
      [CHROME_DEVTOOLS_MCP_SERVER_NAME]: {
        type: 'stdio' as const,
        command,
        args: [...commandArgs, ...buildChromeDevtoolsArgs()],
        scope: 'dynamic' as const,
        env: {
          CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS: '1',
          CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1',
        },
      },
    },
    // Only the observational tools skip the prompt. Everything that can act on
    // the page is left to the normal MCP permission flow.
    allowedTools: CHROME_DEVTOOLS_READ_ONLY_TOOLS.map(name =>
      buildMcpToolName(CHROME_DEVTOOLS_MCP_SERVER_NAME, name),
    ),
    systemPrompt: getChromeDevtoolsSystemPrompt(),
  }
}
