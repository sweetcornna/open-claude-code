/**
 * OAuth control requests for headless sessions — both the MCP-server flows
 * and the Anthropic (`claude_authenticate`) one.
 *
 * All five were branches of `runHeadlessStreaming`'s control-request chain.
 * They share the per-server flow bookkeeping that now lives on
 * `HeadlessRunState` (activeOAuthFlows, oauthCallbackSubmitters,
 * oauthManualCallbackUsed, oauthAuthPromises, claudeOAuth), which is why they
 * are one module rather than five.
 */
import omit from 'lodash-es/omit.js'
import reject from 'lodash-es/reject.js'
import { logEvent } from 'src/services/analytics/index.js'
import { getAccountInformation } from 'src/utils/auth/auth.js'
import { installOAuthTokens } from 'src/cli/handlers/auth.js'
import { OAuthService } from 'src/services/oauth/index.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import type { SDKControlRequest } from 'src/entrypoints/sdk/controlTypes.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { errorMessage } from 'src/utils/runtime/errors.js'
import { reconnectMcpServerImpl } from 'src/services/mcp/client.js'
import {
  getMcpConfigByName,
  isMcpServerDisabled,
} from 'src/services/mcp/config.js'
import {
  performMCPOAuthFlow,
  revokeServerTokens,
} from 'src/services/mcp/auth.js'
import { getMcpPrefix } from 'src/services/mcp/mcpStringUtils.js'
import { commandBelongsToServer } from 'src/services/mcp/utils.js'
import {
  sendControlResponseError,
  sendControlResponseSuccess,
} from './headlessControlResponses.js'
import type { HeadlessRunState } from './headlessRunState.js'

/**
 * MCP server OAuth: starts (or restarts) the flow and hands the auth URL
 * back to the SDK consumer, which owns the browser in headless mode.
 */
export async function handleMcpAuthenticate(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): Promise<void> {
  const serverName = req.serverName as string
  const currentAppState = state.getAppState()
  const config =
    getMcpConfigByName(serverName) ??
    state.mcpClients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    sendControlResponseError(state, msg, `Server not found: ${serverName}`)
  } else if (config.type !== 'sse' && config.type !== 'http') {
    sendControlResponseError(
      state,
      msg,
      `Server type "${config.type}" does not support OAuth authentication`,
    )
  } else {
    try {
      // Abort any previous in-flight OAuth flow for this server
      state.activeOAuthFlows.get(serverName as string)?.abort()
      const controller = new AbortController()
      state.activeOAuthFlows.set(serverName as string, controller)

      // Capture the auth URL from the callback
      let resolveAuthUrl: (url: string) => void
      const authUrlPromise = new Promise<string>(resolve => {
        resolveAuthUrl = resolve
      })

      // Start the OAuth flow in the background
      const oauthPromise = performMCPOAuthFlow(
        serverName as string,
        config,
        url => resolveAuthUrl!(url),
        controller.signal,
        {
          skipBrowserOpen: true,
          onWaitingForCallback: submit => {
            state.oauthCallbackSubmitters.set(serverName as string, submit)
          },
        },
      )

      // Wait for the auth URL (or the flow to complete without needing redirect)
      const authUrl = await Promise.race([
        authUrlPromise,
        oauthPromise.then(() => null as string | null),
      ])

      if (authUrl) {
        sendControlResponseSuccess(state, msg, {
          authUrl,
          requiresUserAction: true,
        })
      } else {
        sendControlResponseSuccess(state, msg, {
          requiresUserAction: false,
        })
      }

      // Store auth-only promise for mcp_oauth_callback_url handler.
      // Don't swallow errors — the callback handler needs to detect
      // auth failures and report them to the caller.
      state.oauthAuthPromises.set(serverName, oauthPromise)

      // Handle background completion — reconnect after auth.
      // When manual callback is used, skip the reconnect here;
      // the extension's handleAuthDone → mcp_reconnect handles it
      // (which also updates dynamicMcpState for tool registration).
      const fullFlowPromise = oauthPromise
        .then(async () => {
          // Don't reconnect if the server was disabled during the OAuth flow
          if (isMcpServerDisabled(serverName as string)) {
            return
          }
          // Skip reconnect if the manual callback path was used —
          // handleAuthDone will do it via mcp_reconnect (which
          // updates dynamicMcpState for tool registration).
          if (state.oauthManualCallbackUsed.has(serverName as string)) {
            return
          }
          // Reconnect the server after successful auth
          const result = await reconnectMcpServerImpl(
            serverName as string,
            config,
          )
          const prefix = getMcpPrefix(serverName as string)
          state.setAppState(prev => ({
            ...prev,
            mcp: {
              ...prev.mcp,
              clients: prev.mcp.clients.map(c =>
                c.name === (serverName as string) ? result.client : c,
              ),
              tools: [
                ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
                ...result.tools,
              ],
              commands: [
                ...reject(prev.mcp.commands, c =>
                  commandBelongsToServer(c, serverName as string),
                ),
                ...result.commands,
              ],
              resources:
                result.resources && result.resources.length > 0
                  ? {
                      ...prev.mcp.resources,
                      [serverName as string]: result.resources,
                    }
                  : omit(prev.mcp.resources, serverName as string),
            },
          }))
          // Also update dynamicMcpState so run() picks up the new tools
          // on the next turn (run() reads dynamicMcpState, not appState)
          state.dynamicMcpState = {
            ...state.dynamicMcpState,
            clients: [
              ...state.dynamicMcpState.clients.filter(
                c => c.name !== serverName,
              ),
              result.client,
            ],
            tools: [
              ...state.dynamicMcpState.tools.filter(
                t => !t.name?.startsWith(prefix),
              ),
              ...result.tools,
            ],
          }
        })
        .catch(error => {
          logForDebugging(
            `MCP OAuth failed for ${serverName as string}: ${error}`,
            { level: 'error' },
          )
        })
        .finally(() => {
          // Clean up only if this is still the active flow
          if (state.activeOAuthFlows.get(serverName as string) === controller) {
            state.activeOAuthFlows.delete(serverName as string)
            state.oauthCallbackSubmitters.delete(serverName as string)
            state.oauthManualCallbackUsed.delete(serverName as string)
            state.oauthAuthPromises.delete(serverName as string)
          }
        })
      void fullFlowPromise
    } catch (error) {
      sendControlResponseError(state, msg, errorMessage(error))
    }
  }
}

/**
 * Manual OAuth redirect submission, for clients where the localhost
 * listener is unreachable (browser-based IDEs).
 */
export async function handleMcpOAuthCallbackUrl(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): Promise<void> {
  const serverName = req.serverName as string
  const callbackUrl = req.callbackUrl as string
  const submit = state.oauthCallbackSubmitters.get(serverName)
  if (submit) {
    // Validate the callback URL before submitting. The submit
    // callback in auth.ts silently ignores URLs missing a code
    // param, which would leave the auth promise unresolved and
    // block the control message loop until timeout.
    let hasCodeOrError = false
    try {
      const parsed = new URL(callbackUrl as string | URL)
      hasCodeOrError =
        parsed.searchParams.has('code') || parsed.searchParams.has('error')
    } catch {
      // Invalid URL
    }
    if (!hasCodeOrError) {
      sendControlResponseError(
        state,
        msg,
        'Invalid callback URL: missing authorization code. Please paste the full redirect URL including the code parameter.',
      )
    } else {
      state.oauthManualCallbackUsed.add(serverName)
      submit(callbackUrl as string)
      // Wait for auth (token exchange) to complete before responding.
      // Reconnect is handled by the extension via handleAuthDone →
      // mcp_reconnect (which updates dynamicMcpState for tools).
      const authPromise = state.oauthAuthPromises.get(serverName)
      if (authPromise) {
        try {
          await authPromise
          sendControlResponseSuccess(state, msg)
        } catch (error) {
          sendControlResponseError(
            state,
            msg,
            error instanceof Error
              ? error.message
              : 'OAuth authentication failed',
          )
        }
      } else {
        sendControlResponseSuccess(state, msg)
      }
    }
  } else {
    sendControlResponseError(
      state,
      msg,
      `No active OAuth flow for server: ${serverName}`,
    )
  }
}

/**
 * Anthropic OAuth over the control channel. Single-slot: a second request
 * cleans up the first.
 */
export async function handleClaudeAuthenticate(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): Promise<void> {
  // Anthropic OAuth over the control channel. The SDK client owns
  // the user's browser (we're headless in -p mode); we hand back
  // both URLs and wait. Automatic URL → localhost listener catches
  // the redirect if the browser is on this host; manual URL → the
  // success page shows "code#state" for claude_oauth_callback.
  const loginWithClaudeAi = req.loginWithClaudeAi as boolean | undefined

  // Clean up any prior flow. cleanup() closes the localhost listener
  // and nulls the manual resolver. The prior `flow` promise is left
  // pending (AuthCodeListener.close() does not reject) but its object
  // graph becomes unreachable once the server handle is released and
  // is GC'd — no fd or port is held.
  state.claudeOAuth?.service.cleanup()

  logEvent('tengu_oauth_flow_start', {
    loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
  })

  const service = new OAuthService()
  let urlResolver!: (urls: { manualUrl: string; automaticUrl: string }) => void
  const urlPromise = new Promise<{
    manualUrl: string
    automaticUrl: string
  }>(resolve => {
    urlResolver = resolve
  })

  const flow = service
    .startOAuthFlow(
      async (manualUrl, automaticUrl) => {
        // automaticUrl is always defined when skipBrowserOpen is set;
        // the signature is optional only for the existing single-arg callers.
        urlResolver({ manualUrl, automaticUrl: automaticUrl! })
      },
      {
        loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean,
        skipBrowserOpen: true,
      },
    )
    .then(async tokens => {
      // installOAuthTokens: resolve profile → saveOAuthTokensIfNeeded (or
      // createAndStoreApiKey + removeClaudeAIOAuthTokens for Console) →
      // clearOAuthTokenCache → store account info → fetch roles →
      // clearAuthRelatedCaches. It does NOT call performLogout — logging in
      // must not wipe the user's provider configuration. After this resolves,
      // the memoized getClaudeAIOAuthTokens in this process is invalidated;
      // the next API call re-reads keychain/file and works. No respawn.
      await installOAuthTokens(tokens)
      logEvent('tengu_oauth_success', {
        loginWithClaudeAi: (loginWithClaudeAi ?? true) as boolean | number,
      })
    })
    .finally(() => {
      service.cleanup()
      if (state.claudeOAuth?.service === service) {
        state.claudeOAuth = null
      }
    })

  state.claudeOAuth = { service, flow }

  // Attach the rejection handler before awaiting so a synchronous
  // startOAuthFlow failure doesn't surface as an unhandled rejection.
  // The claude_oauth_callback handler re-awaits flow for the manual
  // path and surfaces the real error to the client.
  void flow.catch(err =>
    logForDebugging(`claude_authenticate flow ended: ${err}`, {
      level: 'info',
    }),
  )

  try {
    // Race against flow: if startOAuthFlow rejects before calling
    // the authURLHandler (e.g. AuthCodeListener.start() fails with
    // EACCES or fd exhaustion), urlPromise would pend forever and
    // wedge the stdin loop. flow resolving first is unreachable in
    // practice (it's suspended on the same urls we're waiting for).
    const { manualUrl, automaticUrl } = await Promise.race([
      urlPromise,
      flow.then(() => {
        throw new Error('OAuth flow completed without producing auth URLs')
      }),
    ])
    sendControlResponseSuccess(state, msg, {
      manualUrl,
      automaticUrl,
    })
  } catch (error) {
    sendControlResponseError(state, msg, errorMessage(error))
  }
}

/**
 * Completion half of the Anthropic flow — injects a manual code when this is
 * claude_oauth_callback, then reports the resulting account either way.
 */
export async function handleClaudeOAuthCallback(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): Promise<void> {
  if (!state.claudeOAuth) {
    sendControlResponseError(state, msg, 'No active claude_authenticate flow')
  } else {
    // Inject the manual code synchronously — must happen in stdin
    // message order so a subsequent claude_authenticate doesn't
    // replace the service before this code lands.
    if (req.subtype === 'claude_oauth_callback') {
      state.claudeOAuth.service.handleManualAuthCodeInput({
        authorizationCode: req.authorizationCode as string,
        state: req.state as string,
      })
    }
    // Detach the await — the stdin reader is serial and blocking
    // here deadlocks claude_oauth_wait_for_completion: flow may
    // only resolve via a future claude_oauth_callback on stdin,
    // which can't be read while we're parked. Capture the binding;
    // claudeOAuth is nulled in flow's own .finally.
    const { flow } = state.claudeOAuth
    void flow.then(
      () => {
        const accountInfo = getAccountInformation()
        sendControlResponseSuccess(state, msg, {
          account: {
            email: accountInfo?.email,
            organization: accountInfo?.organization,
            subscriptionType: accountInfo?.subscription,
            tokenSource: accountInfo?.tokenSource,
            apiKeySource: accountInfo?.apiKeySource,
            apiProvider: getAPIProvider(),
          },
        })
      },
      (error: unknown) =>
        sendControlResponseError(state, msg, errorMessage(error)),
    )
  }
}

/**
 * Revoke a server's stored tokens and reconnect it unauthenticated.
 */
export async function handleMcpClearAuth(
  state: HeadlessRunState,
  msg: SDKControlRequest,
  req: Record<string, unknown>,
): Promise<void> {
  const serverName = req.serverName as string
  const currentAppState = state.getAppState()
  const config =
    getMcpConfigByName(serverName) ??
    state.mcpClients.find(c => c.name === serverName)?.config ??
    currentAppState.mcp.clients.find(c => c.name === serverName)?.config ??
    null
  if (!config) {
    sendControlResponseError(state, msg, `Server not found: ${serverName}`)
  } else if (config.type !== 'sse' && config.type !== 'http') {
    sendControlResponseError(
      state,
      msg,
      `Cannot clear auth for server type "${config.type}"`,
    )
  } else {
    await revokeServerTokens(serverName, config)
    const result = await reconnectMcpServerImpl(serverName, config)
    const prefix = getMcpPrefix(serverName)
    state.setAppState(prev => ({
      ...prev,
      mcp: {
        ...prev.mcp,
        clients: prev.mcp.clients.map(c =>
          c.name === (serverName as string) ? result.client : c,
        ),
        tools: [
          ...reject(prev.mcp.tools, t => t.name?.startsWith(prefix)),
          ...result.tools,
        ],
        commands: [
          ...reject(prev.mcp.commands, c =>
            commandBelongsToServer(c, serverName),
          ),
          ...result.commands,
        ],
        resources:
          result.resources && result.resources.length > 0
            ? {
                ...prev.mcp.resources,
                [serverName]: result.resources,
              }
            : omit(prev.mcp.resources, serverName),
      },
    }))
    sendControlResponseSuccess(state, msg, {})
  }
}
