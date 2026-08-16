import { fileURLToPath } from 'node:url'
import { assertProductionSecrets, resolveDatabasePath } from './configRules'

function parseBoolean(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) return defaultValue
  return value === '1' || value.toLowerCase() === 'true'
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const isProduction = process.env.NODE_ENV === 'production'
const tokenPepper =
  process.env.RCS_TOKEN_PEPPER ?? 'development-only-token-pepper-change-me'
const workerJwtSecret =
  process.env.RCS_WORKER_JWT_SECRET ??
  'development-only-worker-jwt-secret-change-me'

assertProductionSecrets(process.env, isProduction)

// Repo-local fallback for `bun run rcs` on a developer machine: the container
// image's /app/data mount does not exist there and cannot be created.
const developmentDatabasePath = fileURLToPath(
  new URL('../data/rcs.sqlite', import.meta.url),
)

export const config = {
  version: process.env.RCS_VERSION || '0.2.0',
  port: parsePositiveInt(process.env.RCS_PORT, 3000),
  host: process.env.RCS_HOST || '0.0.0.0',
  apiKeys: (process.env.RCS_API_KEYS || '')
    .split(',')
    .map(key => key.trim())
    .filter(Boolean),
  baseUrl: process.env.RCS_BASE_URL || '',
  databasePath: resolveDatabasePath(
    process.env.RCS_DATABASE_PATH,
    isProduction,
    developmentDatabasePath,
  ),
  tokenPepper,
  workerJwtSecret,
  allowRegistration: parseBoolean(process.env.RCS_ALLOW_REGISTRATION, false),
  legacyApiKeyAuth: parseBoolean(process.env.RCS_LEGACY_API_KEY_AUTH, false),
  trustProxy: parseBoolean(process.env.RCS_TRUST_PROXY, false),
  pollTimeout: parsePositiveInt(process.env.RCS_POLL_TIMEOUT, 8),
  heartbeatInterval: parsePositiveInt(process.env.RCS_HEARTBEAT_INTERVAL, 20),
  jwtExpiresIn: Math.min(
    parsePositiveInt(process.env.RCS_JWT_EXPIRES_IN, 900),
    3600,
  ),
  disconnectTimeout: parsePositiveInt(process.env.RCS_DISCONNECT_TIMEOUT, 300),
  webCorsOrigins: (process.env.RCS_WEB_CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean),
  wsIdleTimeout: parsePositiveInt(process.env.RCS_WS_IDLE_TIMEOUT, 30),
  wsKeepaliveInterval: parsePositiveInt(
    process.env.RCS_WS_KEEPALIVE_INTERVAL,
    20,
  ),
  maxEnvironmentsPerAccount: parsePositiveInt(
    process.env.RCS_MAX_ENVIRONMENTS_PER_ACCOUNT,
    50,
  ),
  maxSessionsPerAccount: parsePositiveInt(
    process.env.RCS_MAX_SESSIONS_PER_ACCOUNT,
    1000,
  ),
  maxEventBytes: parsePositiveInt(process.env.RCS_MAX_EVENT_BYTES, 256 * 1024),
  registrationRateLimit: parsePositiveInt(
    process.env.RCS_REGISTRATION_RATE_LIMIT,
    5,
  ),
  registrationRateWindowSeconds: parsePositiveInt(
    process.env.RCS_REGISTRATION_RATE_WINDOW_SECONDS,
    3600,
  ),
  loginRateLimit: parsePositiveInt(process.env.RCS_LOGIN_RATE_LIMIT, 10),
  loginRateWindowSeconds: parsePositiveInt(
    process.env.RCS_LOGIN_RATE_WINDOW_SECONDS,
    900,
  ),
} as const

export function getBaseUrl(): string {
  const url = config.baseUrl || `http://localhost:${config.port}`
  return url.replace(/\/+$/, '')
}
