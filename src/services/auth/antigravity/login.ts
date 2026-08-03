/**
 * Antigravity interactive login: loopback callback server → Google consent →
 * code exchange → project discovery → credential file.
 *
 * Reuses the existing AuthCodeListener (the same redirect-capture server the
 * Anthropic OAuth flow uses) rather than standing up a second HTTP server;
 * only the callback path and the success page differ, both of which the
 * listener already parameterises.
 *
 * Service layer only — no Ink/React imports — so /login, the onboarding
 * wizard, and the search-source picker can all call it.
 */

import type { ServerResponse } from 'http'
import { AuthCodeListener } from 'src/services/oauth/auth-code-listener.js'
import { generateState } from 'src/services/oauth/crypto.js'
import { openBrowser } from 'src/utils/network/browser.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  ANTIGRAVITY_CALLBACK_PATH,
  ANTIGRAVITY_CALLBACK_PORT,
} from './constants.js'
import {
  buildAntigravityAuthUrl,
  discoverAntigravityProject,
  exchangeAntigravityCode,
  fetchAntigravityUserEmail,
} from './oauth.js'
import { saveAntigravityTokens } from './store.js'

export type AntigravityLoginResult = {
  /** Google account the tokens belong to, when userinfo was reachable. */
  email?: string
  /** cloudaicompanion project every generate request must carry. */
  projectId: string
}

export type AntigravityLoginOptions = {
  signal?: AbortSignal
  /** Called once the consent URL is known, before the browser is opened. */
  onAuthUrl?: (url: string) => void
  /** Skip opening a browser (headless/SSH); the caller shows the URL. */
  noBrowser?: boolean
}

const SUCCESS_HTML =
  '<!doctype html><meta charset="utf-8"><title>Antigravity login</title>' +
  '<body style="font-family:system-ui;padding:3rem;text-align:center">' +
  '<h1>Login successful</h1><p>You can close this window and return to the terminal.</p></body>'

function writeSuccessPage(res: ServerResponse): void {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(SUCCESS_HTML)
}

/**
 * Bind the callback server, preferring the port the Antigravity IDE registers.
 *
 * Google's installed-app clients match the loopback redirect on path, not port,
 * so falling back to an OS-assigned port when 51121 is occupied still produces
 * an accepted redirect_uri — and beats failing the login outright because an
 * unrelated process holds the port.
 */
async function startCallbackListener(): Promise<{
  listener: AuthCodeListener
  port: number
}> {
  const preferred = new AuthCodeListener(ANTIGRAVITY_CALLBACK_PATH)
  try {
    const port = await preferred.start(ANTIGRAVITY_CALLBACK_PORT)
    return { listener: preferred, port }
  } catch (error) {
    preferred.close()
    logForDebugging(
      `[Antigravity] Callback port ${ANTIGRAVITY_CALLBACK_PORT} unavailable, using an ephemeral port: ${String(error)}`,
    )
    const fallback = new AuthCodeListener(ANTIGRAVITY_CALLBACK_PATH)
    const port = await fallback.start()
    return { listener: fallback, port }
  }
}

function abortSignalToRejection(signal: AbortSignal | undefined): {
  promise: Promise<never>
  dispose: () => void
} {
  if (!signal) {
    return { promise: new Promise<never>(() => {}), dispose: () => {} }
  }
  let onAbort: (() => void) | null = null
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Antigravity login cancelled'))
      return
    }
    onAbort = () => reject(new Error('Antigravity login cancelled'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    promise,
    dispose: () => {
      if (onAbort) signal.removeEventListener('abort', onAbort)
    },
  }
}

/**
 * Contract export (pinned): run the whole OAuth login. On success the tokens
 * are already persisted, so callers only need the returned identity to render
 * a confirmation and to write the auto-config env.
 */
export async function startAntigravityOAuthLogin(
  options: AntigravityLoginOptions = {},
): Promise<AntigravityLoginResult> {
  const { listener, port } = await startCallbackListener()
  const abort = abortSignalToRejection(options.signal)
  try {
    const state = generateState()
    const redirectUri = `http://localhost:${port}${ANTIGRAVITY_CALLBACK_PATH}`
    const authUrl = buildAntigravityAuthUrl({ state, redirectUri })

    const code = await Promise.race([
      listener.waitForAuthorization(state, async () => {
        options.onAuthUrl?.(authUrl)
        if (!options.noBrowser) {
          await openBrowser(authUrl)
        }
      }),
      abort.promise,
    ])

    // Answer the browser before the slower token/project calls so the user is
    // not left staring at a pending tab.
    listener.handleSuccessRedirect([], (res: ServerResponse) => {
      writeSuccessPage(res)
    })

    const tokens = await Promise.race([
      exchangeAntigravityCode({ code, redirectUri }),
      abort.promise,
    ])
    const email = await Promise.race([
      fetchAntigravityUserEmail(tokens.accessToken).catch(() => undefined),
      abort.promise,
    ])
    const projectId = await Promise.race([
      discoverAntigravityProject({
        accessToken: tokens.accessToken,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
      abort.promise,
    ])

    await saveAntigravityTokens({
      ...tokens,
      ...(email ? { email } : {}),
      projectId,
    })
    return { ...(email ? { email } : {}), projectId }
  } finally {
    abort.dispose()
    listener.close()
  }
}
