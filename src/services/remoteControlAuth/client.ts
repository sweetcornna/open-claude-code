import {
  RemoteControlAuthError,
  type RemoteControlCapabilities,
  type RemoteControlTokenResponse,
  type RemoteControlUser,
} from './types.js'
import { normalizeRemoteControlBaseUrl } from './state.js'

type ErrorPayload = {
  error?: { type?: string; message?: string } | string
}

type JsonValidator<T> = (value: unknown) => value is T

function isRemoteControlUser(value: unknown): value is RemoteControlUser {
  if (!value || typeof value !== 'object') return false
  const user = value as Record<string, unknown>
  return typeof user.id === 'string' && typeof user.username === 'string'
}

function isTokenResponse(value: unknown): value is RemoteControlTokenResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Record<string, unknown>
  return (
    isRemoteControlUser(response.user) &&
    typeof response.access_token === 'string' &&
    typeof response.expires_in === 'number' &&
    typeof response.refresh_token === 'string' &&
    typeof response.refresh_expires_in === 'number'
  )
}

function isCapabilities(value: unknown): value is RemoteControlCapabilities {
  if (!value || typeof value !== 'object') return false
  const capabilities = value as Record<string, unknown>
  return (
    (capabilities.auth_mode === 'accounts' ||
      capabilities.auth_mode === 'legacy_api_key') &&
    typeof capabilities.registration_enabled === 'boolean' &&
    typeof capabilities.access_token_ttl_seconds === 'number' &&
    typeof capabilities.pairing_ttl_seconds === 'number'
  )
}

async function requestJson<T>(
  baseUrl: string,
  path: string,
  init: RequestInit = {},
  validate?: JsonValidator<T>,
): Promise<T> {
  const response = await fetch(
    `${normalizeRemoteControlBaseUrl(baseUrl)}${path}`,
    {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        ...(init.body === undefined
          ? {}
          : { 'Content-Type': 'application/json' }),
        ...init.headers,
      },
    },
  )

  const payload: unknown = await response.json().catch(() => ({}))
  if (!response.ok) {
    // A body-less error response parses to `null`, not to a throw — and the
    // 404 that identifies a legacy server is exactly that shape, so reading
    // `.error` off it unguarded turns legacy detection into a TypeError.
    const error = (payload as ErrorPayload | null)?.error
    const message =
      typeof error === 'string'
        ? error
        : (error?.message ?? 'Remote Control authentication failed')
    const type = typeof error === 'string' ? 'auth_error' : error?.type
    const retryAfter = response.headers.get('Retry-After')
    const retryAfterSeconds =
      retryAfter === null ? undefined : Number(retryAfter)
    throw new RemoteControlAuthError(
      message,
      response.status,
      type,
      Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
    )
  }
  if (validate && !validate(payload)) {
    throw new RemoteControlAuthError(
      'Remote Control server returned an invalid authentication response',
      502,
      'invalid_response',
    )
  }
  return payload as T
}

export function fetchRemoteControlCapabilities(
  baseUrl: string,
): Promise<RemoteControlCapabilities> {
  return requestJson(baseUrl, '/v1/auth/capabilities', {}, isCapabilities)
}

export function loginRemoteControlAccount(
  baseUrl: string,
  username: string,
  password: string,
): Promise<RemoteControlTokenResponse> {
  return requestJson(
    baseUrl,
    '/v1/auth/login',
    {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    },
    isTokenResponse,
  )
}

export function registerRemoteControlAccount(
  baseUrl: string,
  username: string,
  password: string,
): Promise<RemoteControlTokenResponse> {
  return requestJson(
    baseUrl,
    '/v1/auth/register',
    {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    },
    isTokenResponse,
  )
}

export function refreshRemoteControlAccount(
  baseUrl: string,
  refreshToken: string,
): Promise<RemoteControlTokenResponse> {
  return requestJson(
    baseUrl,
    '/v1/auth/refresh',
    {
      method: 'POST',
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
    isTokenResponse,
  )
}

export async function logoutRemoteControlAccount(
  baseUrl: string,
  accessToken: string | undefined,
  refreshToken: string | undefined,
): Promise<void> {
  await requestJson(baseUrl, '/v1/auth/logout', {
    method: 'POST',
    headers:
      accessToken === undefined
        ? undefined
        : { Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify(
      refreshToken === undefined ? {} : { refresh_token: refreshToken },
    ),
  })
}
