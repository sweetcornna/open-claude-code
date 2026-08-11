/**
 * OpenCode Console device-code OAuth — the network half.
 *
 * Pure transport: it talks to the console and returns tokens. Storage,
 * expiry policy and refresh-on-demand live in ./oauth.ts, so this module can be
 * tested against a local server without touching the user's config dir.
 *
 * Shape verified against the live console (2026-08-10). `POST /auth/device/code`
 * with `{client_id}` answers:
 *
 *   { device_code, user_code: "RWTD-JXVR", verification_uri: "/device",
 *     verification_uri_complete: "/device?user_code=…&client_id=…",
 *     expires_in: 900, interval: 5 }
 *
 * Note `verification_uri_complete` is server-RELATIVE. sst/opencode joins it
 * onto the server origin (`${server}${device.verification_uri_complete}`) and so
 * does resolveVerificationUrl below; treating it as absolute yields a URL that
 * does not resolve.
 */

import {
  DEVICE_CODE_GRANT_TYPE,
  OPENCODE_CLIENT_ID,
  OPENCODE_CONSOLE_URL,
  SLOW_DOWN_BACKOFF_MS,
} from './constants.js'

export type DeviceCodeGrant = {
  deviceCode: string
  /** Short code the user types into the browser, e.g. `RWTD-JXVR`. */
  userCode: string
  /** Absolute URL to open. */
  verificationUrl: string
  /** Epoch ms after which the device code is refused. */
  expiresAt: number
  /** Seconds the server asks us to wait between polls. */
  intervalMs: number
}

type DeviceTokens = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export type OpencodeAccount = {
  orgId?: string
  orgName?: string
  email?: string
}

export class OpencodeAuthError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'OpencodeAuthError'
  }
}

type JsonRecord = Record<string, unknown>

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

async function postJson(
  url: string,
  body: JsonRecord,
  signal?: AbortSignal,
): Promise<{ status: number; json: JsonRecord }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  })
  const text = await response.text()
  let json: JsonRecord = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object') json = parsed as JsonRecord
  } catch {
    // Non-JSON bodies show up as gateway HTML on 5xx; the status carries the
    // real information and the caller turns it into a message.
  }
  return { status: response.status, json }
}

async function getJson(
  url: string,
  token: string,
  orgId?: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(orgId ? { 'x-org-id': orgId } : {}),
    },
    ...(signal ? { signal } : {}),
  })
  if (!response.ok) {
    throw new OpencodeAuthError(
      `OpenCode request failed: ${response.status} ${response.statusText} (${url})`,
    )
  }
  return (await response.json()) as unknown
}

/**
 * `verification_uri_complete` joined onto the server origin.
 *
 * Tolerates an absolute value too — a future console version returning one
 * should not break the flow.
 */
export function resolveVerificationUrl(server: string, uri: string): string {
  try {
    return new URL(uri, server).toString()
  } catch {
    return `${server}${uri}`
  }
}

/** Step 1: ask the console for a device code. */
export async function requestDeviceCode(
  server: string = OPENCODE_CONSOLE_URL,
  signal?: AbortSignal,
): Promise<DeviceCodeGrant> {
  const { status, json } = await postJson(
    `${server}/auth/device/code`,
    { client_id: OPENCODE_CLIENT_ID },
    signal,
  )
  const deviceCode = asString(json.device_code)
  const userCode = asString(json.user_code)
  const uri =
    asString(json.verification_uri_complete) ?? asString(json.verification_uri)
  if (status !== 200 || !deviceCode || !userCode || !uri) {
    throw new OpencodeAuthError(
      `Could not start OpenCode device login (HTTP ${status}).`,
      asString(json.error),
    )
  }
  const expiresIn = asNumber(json.expires_in) ?? 900
  const interval = asNumber(json.interval) ?? 5
  return {
    deviceCode,
    userCode,
    verificationUrl: resolveVerificationUrl(server, uri),
    expiresAt: Date.now() + expiresIn * 1000,
    intervalMs: interval * 1000,
  }
}

function readTokens(json: JsonRecord): DeviceTokens | undefined {
  const accessToken = asString(json.access_token)
  const refreshToken = asString(json.refresh_token)
  if (!accessToken || !refreshToken) return undefined
  const expiresIn = asNumber(json.expires_in) ?? 3600
  return { accessToken, refreshToken, expiresAt: Date.now() + expiresIn * 1000 }
}

type PollOptions = {
  server?: string
  signal?: AbortSignal
  /** Injected for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
  /** Absolute deadline, epoch ms. */
  deadline?: number
}

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * Step 2: poll until the user finishes in the browser.
 *
 * `authorization_pending` keeps the current interval; `slow_down` widens it, as
 * RFC 8628 requires. Anything else is terminal — notably `expired_token` and
 * `access_denied`, which must surface rather than spin.
 */
export async function pollForTokens(
  grant: DeviceCodeGrant,
  options: PollOptions = {},
): Promise<DeviceTokens> {
  const server = options.server ?? OPENCODE_CONSOLE_URL
  const sleep = options.sleep ?? realSleep
  const deadline = options.deadline ?? grant.expiresAt
  let wait = grant.intervalMs

  for (;;) {
    if (options.signal?.aborted) {
      throw new OpencodeAuthError('OpenCode login cancelled.', 'aborted')
    }
    if (Date.now() >= deadline) {
      throw new OpencodeAuthError(
        'OpenCode login timed out before it was approved.',
        'expired_token',
      )
    }
    await sleep(wait)

    const { json } = await postJson(
      `${server}/auth/device/token`,
      {
        grant_type: DEVICE_CODE_GRANT_TYPE,
        device_code: grant.deviceCode,
        client_id: OPENCODE_CLIENT_ID,
      },
      options.signal,
    )
    const tokens = readTokens(json)
    if (tokens) return tokens

    const error = asString(json.error) ?? 'unknown_error'
    if (error === 'authorization_pending') continue
    if (error === 'slow_down') {
      wait += SLOW_DOWN_BACKOFF_MS
      continue
    }
    throw new OpencodeAuthError(
      `OpenCode device authorization failed: ${error}`,
      error,
    )
  }
}

/** Exchange a refresh token for a fresh pair. */
export async function refreshTokens(
  refreshToken: string,
  server: string = OPENCODE_CONSOLE_URL,
  signal?: AbortSignal,
): Promise<DeviceTokens> {
  const { status, json } = await postJson(
    `${server}/auth/device/token`,
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: OPENCODE_CLIENT_ID,
    },
    signal,
  )
  const tokens = readTokens(json)
  if (!tokens) {
    throw new OpencodeAuthError(
      `Could not refresh the OpenCode session (HTTP ${status}).`,
      asString(json.error),
    )
  }
  return tokens
}

/**
 * Account identity for display and for the `x-org-id` header.
 *
 * Best-effort: a token that works for inference must not be rejected because
 * the console declined to describe it. When several orgs exist the first by
 * name is taken, matching sst/opencode's own tie-break.
 */
export async function fetchAccount(
  accessToken: string,
  server: string = OPENCODE_CONSOLE_URL,
  signal?: AbortSignal,
): Promise<OpencodeAccount> {
  const [user, orgs] = await Promise.all([
    getJson(`${server}/api/user`, accessToken, undefined, signal).catch(
      () => undefined,
    ),
    getJson(`${server}/api/orgs`, accessToken, undefined, signal).catch(
      () => undefined,
    ),
  ])
  const email =
    user && typeof user === 'object'
      ? asString((user as JsonRecord).email)
      : undefined
  const list = Array.isArray(orgs) ? (orgs as JsonRecord[]) : []
  const sorted = list
    .map(org => ({ id: asString(org.id), name: asString(org.name) }))
    .filter((org): org is { id: string; name: string | undefined } =>
      Boolean(org.id),
    )
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  const org = sorted[0]
  return {
    ...(email ? { email } : {}),
    ...(org?.id ? { orgId: org.id } : {}),
    ...(org?.name ? { orgName: org.name } : {}),
  }
}
