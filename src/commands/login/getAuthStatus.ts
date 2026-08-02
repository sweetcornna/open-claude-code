/**
 * getAuthStatus — pure function; no network calls.
 *
 * Reads process.env + the local OAuth credential file (via the already-memoized
 * getClaudeAIOAuthTokens()) + globalConfig.workspaceApiKey to produce an
 * AuthStatus snapshot used by AuthPlaneSummary for the /login UI.
 *
 * Security contract:
 *   - ANTHROPIC_API_KEY / workspaceApiKey values are NEVER returned raw; only
 *     masked previews are exposed.
 *   - Third-party API key values are NEVER included; only boolean presence flags.
 */

import type { SubscriptionType } from '../../services/oauth/types.js'
import {
  getMergedProviderEnv,
  loadProfilesFile,
} from '../../services/providerProfiles/profiles.js'
import { getClaudeAIOAuthTokens } from '../../utils/auth/auth.js'
import { getGlobalConfig } from '../../utils/config/config.js'
import {
  getAPIProvider,
  type APIProvider,
} from '../../utils/model/providers.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AuthStatus {
  subscription: {
    /** true when a claude.ai OAuth token is present in local storage */
    active: boolean
    /** subscription tier, or null when not logged in / API-key-only mode */
    plan: 'free' | 'pro' | 'max' | 'team' | 'enterprise' | 'unknown' | null
    /** reserved — always null for security (email not included in masked output) */
    accountEmail: null
  }
  workspaceKey: {
    /**
     * true when a workspace API key is available from either the env var or
     * saved settings (workspaceApiKey in ~/.claude.json).
     */
    set: boolean
    /** true when key begins with the expected 'sk-ant-api03-' prefix */
    prefixValid: boolean
    /**
     * Masked preview of the key, e.g. 'sk-a...67 (48 chars)', or null when unset.
     * NEVER contains the raw key value.
     */
    keyPreview: string | null
    /**
     * Where the key came from:
     *   'env'      — ANTHROPIC_API_KEY environment variable
     *   'settings' — workspaceApiKey saved in ~/.claude.json via /login UI
     *   null       — not set
     */
    source: 'env' | 'settings' | null
  }
  /**
   * Read-only visibility of which provider requests actually go to. This is
   * NOT a configuration surface (that stayed with the /login setup forms per
   * the 2026-05-06 decision) — it exists so the first /login screen answers
   * "who am I connected to right now". Base URLs are non-secret; key values
   * are never included.
   */
  activeProvider: {
    provider: APIProvider
    /** Provider-specific base-URL override, or null when using the default. */
    baseUrl: string | null
    /** OpenAI path only: which wire protocol requests use. */
    wireApi: 'chat' | 'responses' | null
    /** OpenAI path only: ChatGPT-subscription auth active. */
    chatgptAuth: boolean
    /** Active saved provider profile name (/provider save|use), if any. */
    profile: string | null
  }
}

// The interactive thirdParty CONFIG surface was removed 2026-05-06: fork's
// /login → "Anthropic Compatible Setup" form is the single source of truth
// for OpenAI-compat configuration. `activeProvider` above is read-only
// status, not a parallel configuration path.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WORKSPACE_KEY_PREFIX = 'sk-ant-api03-'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Produce a masked preview of an API key value.
 * Format: first4 + '...' + last2 + ' (N chars)'
 * e.g.: 'sk-a...67 (48 chars)'
 *
 * E3 fix: keys shorter than 20 chars expose a high % of entropy per char
 * (e.g. 6/14 = 43% exposed). For short/malformed keys, show [redacted] only.
 *
 * Never returns the raw key value.
 */
function maskApiKey(key: string): string {
  const len = key.length
  // E3: short keys — show only length, no prefix
  if (len < 20) return `[redacted] (${len} chars)`
  const first4 = key.slice(0, 4)
  const last2 = key.slice(-2)
  return `${first4}...${last2} (${len} chars)`
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Returns a snapshot of the current auth state by reading:
 *   - process.env.ANTHROPIC_API_KEY (workspace key)
 *   - getClaudeAIOAuthTokens() from the local credential file (subscription OAuth)
 *
 * Third-party provider config (Cerebras / Groq / Qwen / DeepSeek) is owned by
 * fork's existing /login → "Anthropic Compatible Setup" form; the parallel
 * surface here was removed 2026-05-06.
 *
 * This function never throws and never makes network calls.
 */
export function getAuthStatus(): AuthStatus {
  // ---- 1. Subscription OAuth plane ----
  const oauthTokens = getClaudeAIOAuthTokens()
  const subscriptionActive =
    oauthTokens !== null && Boolean(oauthTokens.accessToken)

  let plan: AuthStatus['subscription']['plan'] = null
  if (subscriptionActive && oauthTokens) {
    // 本地持久化或历史 token 中可能出现 'free' 等未纳入 SubscriptionType 的字符串
    const raw = oauthTokens.subscriptionType as
      | (SubscriptionType | 'free')
      | null
    if (
      raw === 'free' ||
      raw === 'pro' ||
      raw === 'max' ||
      raw === 'team' ||
      raw === 'enterprise'
    ) {
      plan = raw
    } else if (raw !== null && raw !== undefined) {
      plan = 'unknown'
    } else {
      plan = null
    }
  }

  // ---- 2. Workspace API key plane (dual-source: env var > settings) ----
  const envKey = (process.env.ANTHROPIC_API_KEY ?? '').trim()
  const settingsKey = getGlobalConfig().workspaceApiKey?.trim() ?? ''

  let rawKey: string
  let keySource: 'env' | 'settings' | null

  if (envKey.length > 0) {
    rawKey = envKey
    keySource = 'env'
  } else if (settingsKey.length > 0) {
    rawKey = settingsKey
    keySource = 'settings'
  } else {
    rawKey = ''
    keySource = null
  }

  const keySet = rawKey.length > 0
  const prefixValid = rawKey.startsWith(WORKSPACE_KEY_PREFIX)
  const keyPreview = keySet ? maskApiKey(rawKey) : null

  // ---- 3. Active provider plane (read-only status, fail-soft) ----
  // getAuthStatus() must never throw; this plane touches settings/profile
  // readers that some test environments stub incompletely, so any failure
  // degrades to the firstParty default instead of breaking /login.
  let activeProvider: AuthStatus['activeProvider'] = {
    provider: 'firstParty',
    baseUrl: null,
    wireApi: null,
    chatgptAuth: false,
    profile: null,
  }
  try {
    const provider = getAPIProvider()
    const mergedEnv = getMergedProviderEnv()
    const baseUrlByProvider: Partial<Record<APIProvider, string | undefined>> =
      {
        firstParty: mergedEnv.ANTHROPIC_BASE_URL,
        openai: mergedEnv.OPENAI_BASE_URL,
        gemini: mergedEnv.GEMINI_BASE_URL,
        grok: mergedEnv.GROK_BASE_URL,
      }
    const chatgptAuth =
      provider === 'openai' && mergedEnv.OPENAI_AUTH_MODE === 'chatgpt'
    let wireApi: 'chat' | 'responses' | null = null
    if (provider === 'openai') {
      const explicit = mergedEnv.OPENAI_WIRE_API?.trim().toLowerCase()
      wireApi =
        explicit === 'responses' || (explicit !== 'chat' && chatgptAuth)
          ? 'responses'
          : 'chat'
    }
    activeProvider = {
      provider,
      baseUrl: baseUrlByProvider[provider]?.trim() || null,
      wireApi,
      chatgptAuth,
      profile: loadProfilesFile().active ?? null,
    }
  } catch {
    // keep the fail-soft default
  }

  return {
    subscription: {
      active: subscriptionActive,
      plan,
      accountEmail: null,
    },
    workspaceKey: {
      set: keySet,
      prefixValid,
      keyPreview,
      source: keySource,
    },
    activeProvider,
  }
}
