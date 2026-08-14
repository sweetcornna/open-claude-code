/**
 * `occ mcp login <name>` / `occ mcp logout <name>` — the OAuth half of MCP
 * server management, from the CLI instead of the interactive `/mcp` panel.
 *
 * Why this exists: before it, the only way to authenticate an MCP server was
 * the Ink panel, so a headless or CI session with an OAuth-gated server had no
 * way in at all — the tools simply never appeared. The whole flow already runs
 * without a TTY (`headlessOAuthControl.ts` drives the same functions over the
 * SDK control channel); the CLI just had no entry point.
 *
 * **`--no-browser` is not the same as unattended.** A human still has to open
 * the printed URL and approve; the loopback callback server is unconditional
 * in `performMCPOAuthFlow`, and there is no device-code or client-credentials
 * grant to fall back to. What `--no-browser` buys is SSH and container
 * sessions: print the URL, let the operator open it wherever their browser
 * lives, and paste the redirect back. Promising more than that would be a lie
 * the first time someone put it in a cron job.
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */
import type { Command as CommanderCommand } from '@commander-js/extra-typings'
import { createInterface } from 'readline/promises'
import { cliError, cliOk } from '../../cli/exit.js'
import { BIN_NAME } from '../../constants/brand.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type {
  McpHTTPServerConfig,
  McpSSEServerConfig,
  McpServerConfig,
} from '../../services/mcp/types.js'
import { errorMessage } from '../../utils/runtime/errors.js'

/**
 * Whether a configured server can do OAuth at all, and why not when it can't.
 *
 * Split out because the answer is not "type is sse or http": `claudeai-proxy`
 * servers are authenticated by the user's own Claude login and have no
 * per-server token to grant or revoke, so pointing `mcp login` at one should
 * say so rather than fail somewhere inside the flow.
 */
export type McpAuthTarget =
  | { kind: 'oauth'; config: McpSSEServerConfig | McpHTTPServerConfig }
  | { kind: 'claudeai-proxy' }
  | { kind: 'unsupported-transport'; type: string }

export function classifyMcpAuthTarget(config: McpServerConfig): McpAuthTarget {
  if (config.type === 'claudeai-proxy') return { kind: 'claudeai-proxy' }
  if (config.type === 'sse' || config.type === 'http') {
    return { kind: 'oauth', config }
  }
  return { kind: 'unsupported-transport', type: config.type ?? 'stdio' }
}

/** Shared "this server can't do OAuth" copy for both subcommands. */
export function describeUnsupportedTarget(
  name: string,
  target: Exclude<McpAuthTarget, { kind: 'oauth' }>,
): string {
  if (target.kind === 'claudeai-proxy') {
    return (
      `${name} is a claude.ai connector — it uses your Claude login, not a per-server OAuth grant. ` +
      `Run \`${BIN_NAME} /login\` to change that account.`
    )
  }
  return `${name} is a "${target.type}" server; only http and sse servers use OAuth.`
}

async function resolveTarget(
  name: string,
): Promise<McpSSEServerConfig | McpHTTPServerConfig> {
  const { getMcpConfigByName } = await import('../../services/mcp/config.js')
  const config = getMcpConfigByName(name)
  if (!config) {
    cliError(
      `No MCP server named "${name}". Run \`${BIN_NAME} mcp list\` to see configured servers.`,
    )
  }
  const target = classifyMcpAuthTarget(config)
  if (target.kind !== 'oauth') {
    cliError(describeUnsupportedTarget(name, target))
  }
  return target.config
}

async function mcpLoginHandler(
  name: string,
  options: { browser?: boolean },
): Promise<void> {
  const config = await resolveTarget(name)
  const openBrowser = options.browser !== false

  logEvent('tengu_mcp_login_command', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  const { performMCPOAuthFlow, revokeServerTokens } = await import(
    '../../services/mcp/auth.js'
  )

  // Clear first so a stale or partially-scoped grant can't short-circuit the
  // new one. `preserveStepUpState: true` keeps any step-up context the server
  // asked for — the interactive panel does exactly this before re-auth.
  await revokeServerTokens(name, config, { preserveStepUpState: true })

  const controller = new AbortController()
  const onSigint = () => controller.abort()
  process.on('SIGINT', onSigint)

  try {
    await performMCPOAuthFlow(
      name,
      config,
      url => {
        if (openBrowser) {
          process.stderr.write(`Opening browser to authorize ${name}…\n`)
        } else {
          process.stderr.write(
            `Open this URL to authorize ${name}:\n\n  ${url}\n\n`,
          )
        }
      },
      controller.signal,
      {
        skipBrowserOpen: !openBrowser,
        // Only armed on the --no-browser path: with a browser open the
        // loopback callback lands on its own, and a readline prompt would sit
        // there stealing stdin for a URL the user never has to see.
        ...(openBrowser
          ? {}
          : {
              onWaitingForCallback: submit => {
                void promptForRedirect(submit, controller.signal)
              },
            }),
      },
    )
    cliOk(`Authenticated with ${name}.`)
  } catch (error) {
    if (controller.signal.aborted) {
      cliError('Authentication cancelled.')
    }
    cliError(`Authentication failed for ${name}: ${errorMessage(error)}`)
  } finally {
    process.off('SIGINT', onSigint)
  }
}

/**
 * Offer to take the redirect URL by hand, for the SSH case where the browser
 * runs on another machine and the loopback listener will never be hit.
 *
 * Fire-and-forget on purpose: whichever resolves first wins — the loopback
 * server if the browser is local after all, this prompt if it isn't.
 */
async function promptForRedirect(
  submit: (callbackUrl: string) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!process.stdin.isTTY) return
  const rl = createInterface({ input: process.stdin, output: process.stderr })
  try {
    const answer = await rl.question(
      'After approving, paste the URL you were redirected to (or press Ctrl-C): ',
      { signal },
    )
    const trimmed = answer.trim()
    if (trimmed) submit(trimmed)
  } catch {
    // Aborted, or the loopback callback already completed the flow.
  } finally {
    rl.close()
  }
}

async function mcpLogoutHandler(name: string): Promise<void> {
  const config = await resolveTarget(name)

  logEvent('tengu_mcp_logout_command', {
    name: name as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  const { revokeServerTokens } = await import('../../services/mcp/auth.js')
  try {
    // Revokes server-side where the provider supports RFC 7009, and clears
    // every local issuer slot either way — so this is still the right thing
    // to run when the remote is unreachable.
    await revokeServerTokens(name, config)
  } catch (error) {
    cliError(`Could not clear credentials for ${name}: ${errorMessage(error)}`)
  }
  cliOk(`Cleared stored OAuth credentials for ${name}.`)
}

/** Registers `mcp login` and `mcp logout` on the given Commander command. */
export function registerMcpAuthCommands(mcp: CommanderCommand): void {
  mcp
    .command('login <name>')
    .description('Authenticate with an MCP server over OAuth')
    .option(
      '--no-browser',
      'Print the authorization URL instead of opening a browser (for SSH and headless sessions — paste the redirect URL back when prompted)',
    )
    .action(async (name: string, options: { browser?: boolean }) => {
      await mcpLoginHandler(name, options)
    })

  mcp
    .command('logout <name>')
    .description('Clear stored OAuth credentials for an MCP server')
    .action(async (name: string) => {
      await mcpLogoutHandler(name)
    })
}
