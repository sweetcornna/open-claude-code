import type {
  ControlResponse,
  Environment,
  Session,
  SessionEvent,
} from '../types'

const BASE = ''

export interface AccountUser {
  id: string
  username: string
}

export interface AuthCapabilities {
  auth_mode: string
  registration_enabled: boolean
  pairing_ttl_seconds?: number
}

interface AuthResponse {
  user: AccountUser
}

interface PairingResponse extends AuthResponse {
  session_id: string
}

interface ApiErrorPayload {
  error?: {
    message?: string
    type?: string
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly type: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function api<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const opts: RequestInit = {
    method,
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  }
  if (body !== undefined) {
    opts.body = JSON.stringify(body)
  }

  const res = await fetch(`${BASE}${path}`, opts)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = undefined
  }

  if (!res.ok) {
    const payload = data as ApiErrorPayload | undefined
    const error = payload?.error
    throw new ApiError(
      error?.message || res.statusText || 'Request failed',
      res.status,
      error?.type || 'unknown',
    )
  }
  return data as T
}

export function apiFetchAuthCapabilities() {
  return api<AuthCapabilities>('GET', '/web/auth/capabilities')
}

export function apiLogin(username: string, password: string) {
  return api<AuthResponse>('POST', '/web/auth/login', { username, password })
}

export function apiRegister(username: string, password: string) {
  return api<AuthResponse>('POST', '/web/auth/register', {
    username,
    password,
  })
}

export function apiLogout() {
  return api<{ status: string }>('POST', '/web/auth/logout')
}

export function apiFetchMe() {
  return api<AuthResponse>('GET', '/web/auth/me')
}

export function apiPair(pairingCode: string) {
  return api<PairingResponse>('POST', '/web/auth/pair', {
    code: pairingCode,
  })
}

export function apiFetchSessions() {
  return api<Session[]>('GET', '/web/sessions')
}

export function apiFetchAllSessions() {
  return api<Session[]>('GET', '/web/sessions/all')
}

export function apiFetchSession(id: string) {
  return api<Session>('GET', `/web/sessions/${encodeURIComponent(id)}`)
}

export function apiFetchSessionHistory(id: string) {
  return api<{ events: SessionEvent[] }>(
    'GET',
    `/web/sessions/${encodeURIComponent(id)}/history`,
  )
}

export function apiFetchEnvironments() {
  return api<Environment[]>('GET', '/web/environments')
}

export function apiSendEvent(sessionId: string, body: Record<string, unknown>) {
  return api<void>(
    'POST',
    `/web/sessions/${encodeURIComponent(sessionId)}/events`,
    body,
  )
}

export function apiSendControl(sessionId: string, body: ControlResponse) {
  return api<void>(
    'POST',
    `/web/sessions/${encodeURIComponent(sessionId)}/control`,
    body,
  )
}

export function apiInterrupt(sessionId: string) {
  return api<void>(
    'POST',
    `/web/sessions/${encodeURIComponent(sessionId)}/interrupt`,
  )
}

export function apiCreateSession(body: {
  title?: string
  environment_id?: string
}) {
  return api<Session>('POST', '/web/sessions', body)
}
