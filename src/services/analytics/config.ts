/**
 * Shared analytics configuration
 *
 * Common logic for determining when analytics should be disabled
 * across all analytics systems (Datadog, 1P)
 */

import { isEnvTruthy } from '../../utils/config/envUtils.js'
import { isTelemetryDisabled } from '../../utils/auth/privacyLevel.js'

/**
 * Check if analytics operations should be disabled
 *
 * Analytics is disabled in the following cases:
 * - Test environment (NODE_ENV === 'test')
 * - Third-party cloud providers (Bedrock/Vertex)
 * - Privacy level is no-telemetry or essential-traffic
 */
export function isAnalyticsDisabled(): boolean {
  return (
    process.env.NODE_ENV === 'test' ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX) ||
    isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY) ||
    isTelemetryDisabled()
  )
}

/**
 * Opt-in switch for exporting occ's internal events to Anthropic's
 * `/api/event_logging/batch`.
 */
export const FIRST_PARTY_TELEMETRY_ENV_VAR = 'OCC_ENABLE_1P_TELEMETRY'

/**
 * Opt-in switch for fetching GrowthBook feature gates from Anthropic.
 */
export const GROWTHBOOK_ENV_VAR = 'OCC_ENABLE_GROWTHBOOK'

/**
 * Both switches default to OFF, which is where occ differs from upstream.
 *
 * Upstream derives "may we talk to api.anthropic.com about this user" from the
 * absence of an opt-OUT (`DISABLE_TELEMETRY`, Bedrock/Vertex/Foundry). For
 * first-party Claude Code that is a defensible product decision; for a fork it
 * is not, and it was not theoretical:
 *
 *   - occ POSTed internal events to `https://api.anthropic.com/api/event_logging/batch`
 *     on every run, authenticated with whatever `ANTHROPIC_API_KEY` held — and
 *     the DeepSeek and OpenCode wires MIRROR a third-party credential into that
 *     variable. See getFirstPartyTelemetryAuthHeaders() in utils/network/http.ts.
 *   - the GrowthBook payload it fetched back was written to disk and then
 *     steered occ's own behaviour for the life of the install. Two functional
 *     outages came out of that (see LOCAL_GATE_DEFAULTS in growthbook.ts).
 *
 * They are two switches, not one, because they are two different exposures:
 * one sends data out, the other takes instructions in. Turning on experiment
 * assignment must not silently start exporting usage events.
 *
 * Env-only by design. `settings.json`'s `env` block is applied into
 * `process.env` at startup, so that is the persistent form — no separate
 * config key, and no way for a value to outlive the environment that set it.
 *
 * The opt-OUTs still win: `isAnalyticsDisabled()` is checked first by both
 * callers, so `DISABLE_TELEMETRY` / Bedrock / Vertex / Foundry keep everything
 * off regardless of what these say.
 */
export function isFirstPartyTelemetryOptedIn(): boolean {
  return isEnvTruthy(process.env[FIRST_PARTY_TELEMETRY_ENV_VAR])
}

/** See isFirstPartyTelemetryOptedIn() for the rationale. */
export function isGrowthBookOptedIn(): boolean {
  return isEnvTruthy(process.env[GROWTHBOOK_ENV_VAR])
}

/**
 * Check if the feedback survey should be suppressed.
 *
 * Unlike isAnalyticsDisabled(), this does NOT block on 3P providers
 * (Bedrock/Vertex/Foundry). The survey is a local UI prompt with no
 * transcript data — enterprise customers capture responses via OTEL.
 */
export function isFeedbackSurveyDisabled(): boolean {
  return process.env.NODE_ENV === 'test' || isTelemetryDisabled()
}
