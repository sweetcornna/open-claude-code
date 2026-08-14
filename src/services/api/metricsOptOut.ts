import { createHash } from 'crypto'
import axios from 'axios'
import {
  getAnthropicApiKeyWithSource,
  getOauthAccountInfo,
  hasProfileScope,
  isClaudeAISubscriber,
} from '../../utils/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config/config.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import { errorMessage } from '../../utils/runtime/errors.js'
import {
  getFirstPartyTelemetryAuthHeaders,
  withOAuth401Retry,
} from '../../utils/network/http.js'
import { logError } from '../../utils/telemetry/log.js'
import { memoizeWithTTLAsync } from '../../utils/collections/memoize.js'
import { isEssentialTrafficOnly } from '../../utils/auth/privacyLevel.js'
import { getClaudeCodeUserAgent } from '../../utils/network/userAgent.js'

type MetricsEnabledResponse = {
  metrics_logging_enabled: boolean
}

type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

type IdentityBoundMetricsCache = NonNullable<
  ReturnType<typeof getGlobalConfig>['metricsStatusCache']
>

// In-memory TTL — dedupes calls within a single process
const CACHE_TTL_MS = 60 * 60 * 1000

// Disk TTL — org settings rarely change. When disk cache is fresher than this,
// we skip the network entirely (no background refresh). This is what collapses
// N `claude -p` invocations into ~1 API call/day.
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000

function getMetricsIdentityKey(): string {
  const account = getOauthAccountInfo()
  if (account) {
    return JSON.stringify([
      account.organizationUuid ?? 'unknown-organization',
      account.accountUuid,
      'oauth',
    ])
  }

  const { key, source } = getAnthropicApiKeyWithSource()
  // API-key sessions do not expose account/org UUIDs. A one-way credential
  // fingerprint supplies the missing identity boundary without persisting the
  // secret itself or reusing one key's org answer for another key.
  const credentialId = key
    ? createHash('sha256').update(key).digest('hex')
    : 'no-credential'
  return JSON.stringify(['unknown-organization', credentialId, source])
}

function getCachedMetricsStatus(): IdentityBoundMetricsCache | undefined {
  return getGlobalConfig().metricsStatusCache
}

/**
 * Internal function to call the API and check if metrics are enabled
 * This is wrapped by memoizeWithTTLAsync to add caching behavior
 */
async function _fetchMetricsEnabled(): Promise<MetricsEnabledResponse> {
  // Same footing as the BigQuery export this gates: the endpoint below is
  // hardcoded to api.anthropic.com, so a DeepSeek/OpenCode credential mirrored
  // into ANTHROPIC_API_KEY must not travel with it. bigqueryExporter already
  // refuses the export itself — this probe runs *before* that check and used to
  // send the mirrored key one request earlier.
  //
  // Failing closed here surfaces as hasError:true from _checkMetricsEnabledAPI,
  // which is not persisted to disk and makes the exporter skip. That is the
  // same outcome as the network being unreachable.
  const authResult = getFirstPartyTelemetryAuthHeaders()
  if (authResult.error) {
    throw new Error(`Auth error: ${authResult.error}`)
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': getClaudeCodeUserAgent(),
    ...authResult.headers,
  }

  const endpoint = `https://api.anthropic.com/api/claude_code/organizations/metrics_enabled`
  const response = await axios.get<MetricsEnabledResponse>(endpoint, {
    headers,
    timeout: 5000,
  })
  return response.data
}

async function _checkMetricsEnabledAPI(
  _identityKey: string,
): Promise<MetricsStatus> {
  // Incident kill switch: skip the network call when nonessential traffic is disabled.
  // Returning enabled:false sheds load at the consumer (bigqueryExporter skips
  // export). Matches the non-subscriber early-return shape below.
  if (isEssentialTrafficOnly()) {
    return { enabled: false, hasError: false }
  }

  try {
    const data = await withOAuth401Retry(_fetchMetricsEnabled, {
      also403Revoked: true,
    })

    logForDebugging(
      `Metrics opt-out API response: enabled=${data.metrics_logging_enabled}`,
    )

    return {
      enabled: data.metrics_logging_enabled,
      hasError: false,
    }
  } catch (error) {
    logForDebugging(
      `Failed to check metrics opt-out status: ${errorMessage(error)}`,
    )
    logError(error)
    return { enabled: false, hasError: true }
  }
}

// Create memoized version with custom error handling
const memoizedCheckMetrics = memoizeWithTTLAsync(
  _checkMetricsEnabledAPI,
  CACHE_TTL_MS,
)
let activeIdentityKey: string | null = null

function activateMetricsIdentity(identityKey: string): void {
  if (activeIdentityKey !== null && activeIdentityKey !== identityKey) {
    // cache.clear() also invalidates in-flight writes in memoizeWithTTLAsync,
    // so an old account's request cannot populate memory after a switch.
    memoizedCheckMetrics.cache.clear()
  }
  activeIdentityKey = identityKey
}

/**
 * Fetch (in-memory memoized) and persist to disk on change.
 * Errors are not persisted — a transient failure should not overwrite a
 * known-good disk value.
 */
async function refreshMetricsStatus(
  identityKey: string,
): Promise<MetricsStatus> {
  const result = await memoizedCheckMetrics(identityKey)
  if (result.hasError) {
    return result
  }

  // Auth can change while the request is in flight. Never return or persist an
  // answer fetched with credentials that are no longer current.
  if (getMetricsIdentityKey() !== identityKey) {
    return { enabled: false, hasError: false }
  }

  const cached = getCachedMetricsStatus()
  const unchanged =
    cached?.identityKey === identityKey && cached.enabled === result.enabled
  // Skip write when unchanged AND timestamp still fresh — avoids config churn
  // when concurrent callers race past a stale disk entry and all try to write.
  if (unchanged && Date.now() - cached.timestamp < DISK_CACHE_TTL_MS) {
    return result
  }

  saveGlobalConfig(current => ({
    ...current,
    metricsStatusCache: {
      enabled: result.enabled,
      timestamp: Date.now(),
      identityKey,
    } as IdentityBoundMetricsCache,
  }))
  return result
}

/**
 * Check if metrics are enabled for the current organization.
 *
 * Two-tier cache:
 * - Disk (24h TTL): survives process restarts. Fresh disk cache → zero network.
 * - In-memory (1h TTL): dedupes the background refresh within a process.
 *
 * The caller (bigqueryExporter) tolerates stale reads — a missed export or
 * an extra one during the 24h window is acceptable.
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  // Service key OAuth sessions lack user:profile scope → would 403.
  // API key users (non-subscribers) fall through and use x-api-key auth.
  // This check runs before the disk read so we never persist auth-state-derived
  // answers — only real API responses go to disk. Otherwise a service-key
  // session would poison the cache for a later full-OAuth session.
  if (isClaudeAISubscriber() && !hasProfileScope()) {
    return { enabled: false, hasError: false }
  }

  const identityKey = getMetricsIdentityKey()
  activateMetricsIdentity(identityKey)

  const cached = getCachedMetricsStatus()
  if (cached?.identityKey === identityKey) {
    if (Date.now() - cached.timestamp > DISK_CACHE_TTL_MS) {
      // saveGlobalConfig's fallback path (config.ts:731) can throw if both
      // locked and fallback writes fail — catch here so fire-and-forget
      // doesn't become an unhandled rejection.
      void refreshMetricsStatus(identityKey).catch(logError)
    }
    return {
      enabled: cached.enabled,
      hasError: false,
    }
  }

  // First-ever run on this machine: block on the network to populate disk.
  return refreshMetricsStatus(identityKey)
}

export function _resetMetricsOptOutCacheForTesting(): void {
  activeIdentityKey = null
  memoizedCheckMetrics.cache.clear()
}
