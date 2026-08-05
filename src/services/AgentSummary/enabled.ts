/**
 * Gate for periodic agent summarization ("recap").
 *
 * Kept separate from agentSummary.ts so the decision can be unit-tested without
 * pulling in runForkedAgent and the whole fork machinery.
 *
 * ## Cost model
 *
 * Each enabled agent costs ONE forked, tool-less inference every
 * SUMMARY_INTERVAL_MS (30s) for as long as it runs — see agentSummary.ts.
 *
 * What the cache actually covers — do NOT read this as "nearly free":
 *
 *  - The fork reuses the agent's own CacheSafeParams (same system prompt,
 *    tools, model, thinking config), so the STABLE PREFIX — system + tools —
 *    is a cache read. It never sets maxOutputTokens, precisely to avoid a
 *    thinking-config mismatch that would bust even that
 *    (agentSummary.ts:122-137), and tools are denied via canUseTool rather
 *    than removed, to keep the cache key identical.
 *  - The MESSAGES segment is NOT cached. selectSummaryContextMessages builds
 *    the window as a reverse suffix, so its starting point moves every tick;
 *    the fork therefore pays full input price on up to
 *    MAX_SUMMARY_CONTEXT_CHARS of transcript (worst case ~50k tokens for a
 *    long-running agent). The fork passes skipCacheWrite because that segment
 *    would never be read back — so there is no 1.25x write premium, but no
 *    read discount either.
 *
 * Real mitigations:
 *
 *  - output is 3-5 words, and the timer is re-armed on completion rather than
 *    on start, so an agent's summaries can never overlap;
 *  - ticks are skipped when the transcript has not changed, when there are
 *    fewer than 3 messages, and while poor mode is active;
 *  - MAX_CONCURRENT_SUMMARY_FORKS caps in-flight forks across ALL agents, so
 *    N background agents cannot fire N simultaneous requests at the account
 *    rate limit.
 *
 * It is still a real, non-trivial API call per agent per 30s.
 * `OCC_AGENT_SUMMARIES=0` (also `false`/`no`/`off`) turns the whole feature
 * off.
 */

// Session state comes from the tool-runtime bootstrapState FACADE, not from
// src/bootstrap/state.js directly. builtin-tools' resumeAgent.ts imports this
// module, so a static edge to the host bootstrap closed a cycle
// (REPL.tsx → resumeAgent.ts → here → bootstrap/state.ts → …existing spine… →
// REPL.tsx) and pushed check:cycles' total budget to 2029/2028. tool-runtime is
// a leaf package with zero src/ imports (enforced by
// src/__tests__/toolRuntimeTypeContract.test.ts), so routing through it
// terminates the chain.
//
// The facade fails fast when unregistered — deliberately, to surface
// registration-order bugs. Safe here: every caller is on an agent
// spawn/resume path, long after session bootstrap has registered the host.
import {
  getIsNonInteractiveSession,
  getSdkAgentProgressSummariesEnabled,
} from '@open-claude-code/tool-runtime/bootstrapState.js'
import { isEnvDefinedFalsy } from '../../utils/config/envUtils.js'

/**
 * Master cost switch. Default ON; only an explicitly falsy
 * `OCC_AGENT_SUMMARIES` turns it off.
 *
 * This is intentionally a hard kill switch that outranks every opt-in
 * (coordinator mode, fork subagents, the SDK control request): it is set by
 * whoever runs the process, and "off" that silently still bills forks would be
 * the surprising reading.
 */
export function areAgentSummariesAllowed(): boolean {
  return !isEnvDefinedFalsy(process.env.OCC_AGENT_SUMMARIES)
}

/**
 * Whether a *background* agent should run periodic summarization.
 *
 * Background agents are the ones with somewhere to show a recap: every surface
 * that renders one (BackgroundAgentSelector, the BackgroundTask pill,
 * BackgroundTasksDialog) filters on `isBackgrounded !== false` /
 * `isBackgroundTask()`, so a foreground sync agent has no row to write into and
 * summarizing it would be pure cost. Foreground agents also have the spinner's
 * live tool activity and usually finish inside a single 30s window.
 *
 * Interactive TUI sessions get it by default — that is the point of this
 * feature. Non-interactive runs (`-p`, SDK) have no such UI, so they stay
 * opt-in through the SDK control request
 * (`setSdkAgentProgressSummariesEnabled`).
 *
 * @param explicitOptIn callers that already know they want summaries
 *   regardless of interactivity (coordinator mode, fork subagents).
 */
export function isBackgroundAgentSummarizationEnabled(
  explicitOptIn = false,
): boolean {
  if (!areAgentSummariesAllowed()) return false
  // getIsNonInteractiveSession() is the exact complement of getIsInteractive()
  // (both read STATE.isInteractive — see src/bootstrap/state/flags.ts:14-20);
  // only the negative form is on the facade, so negate rather than widen it.
  return (
    explicitOptIn ||
    getSdkAgentProgressSummariesEnabled() ||
    !getIsNonInteractiveSession()
  )
}

/**
 * Whether a *foreground* (synchronous, not yet backgrounded) agent should run
 * periodic summarization.
 *
 * Deliberately NOT widened to interactive TUI sessions the way the background
 * gate is. A foreground agent has `isBackgrounded === false`, and every surface
 * that could render a recap filters exactly that out — `useBackgroundAgentTasks`
 * drops it, and `isBackgroundTask()` (src/tasks/types.ts) returns false for it.
 * So a fork every 30s would buy nothing on screen, while the spinner already
 * shows live tool activity. Foreground agents are also usually shorter-lived
 * than one 30s interval.
 *
 * The accepted cost: an agent promoted from foreground to background shows its
 * spawn description until the background summarizer's first tick.
 */
export function isForegroundAgentSummarizationEnabled(): boolean {
  if (!areAgentSummariesAllowed()) return false
  return getSdkAgentProgressSummariesEnabled()
}
