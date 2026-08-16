export type RemoteControlAuthMode = 'accounts' | 'legacy_api_key'

export type RemoteControlCapabilities = {
  auth_mode: RemoteControlAuthMode
  registration_enabled: boolean
  access_token_ttl_seconds: number
  pairing_ttl_seconds: number
}

export type RemoteControlUser = {
  id: string
  username: string
}

export type RemoteControlTokenResponse = {
  user: RemoteControlUser
  access_token: string
  expires_in: number
  refresh_token: string
  refresh_expires_in: number
}

export type StoredRemoteControlCredential = {
  version: 1
  baseUrl: string
  username: string
  refreshToken: string
}

export class RemoteControlAuthError extends Error {
  readonly status: number
  readonly type: string
  readonly retryAfterSeconds?: number

  constructor(
    message: string,
    status: number,
    type = 'remote_control_auth_error',
    retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'RemoteControlAuthError'
    this.status = status
    this.type = type
    this.retryAfterSeconds = retryAfterSeconds
  }
}
