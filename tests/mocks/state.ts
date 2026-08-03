/**
 * Shared COMPLETE mock for src/bootstrap/state.ts
 *
 * The real module is fail-fast (calls throw before bootstrap), so unlike
 * tests/mocks/envUtils.ts this mock cannot delegate to the real
 * implementation — instead it guarantees a complete export surface: hand-tuned
 * safe defaults below, every remaining real export auto-filled, and per-file
 * overrides on top. Completeness matters because mock.module is process-global
 * last-write-wins: a hand-rolled PARTIAL state mock in one file used to break
 * bootstrap/state.test.ts (and everything touching cwd/session identity) in
 * every file that ran after it — order-dependent, Linux-CI-only.
 *
 * Usage:
 *   import { stateMockWith } from '../../../tests/mocks/state.js'
 *   mock.module('src/bootstrap/state.js', stateMockWith({
 *     getSessionId: () => 'my-suite-session',
 *   }))
 *
 * `stateMock` (no overrides) is kept for existing consumers.
 */

import * as realState from 'src/bootstrap/state.js'

function baseStateMock() {
  const noop = () => {}
  let lastAPIRequest: unknown = null
  // Model strings cache. Faithful get/set with null-uninitialized semantics:
  // modelStrings.ts checks `=== null` to decide whether to initialize; an
  // auto-filled `() => undefined` would skip init and send undefined into
  // every downstream model lookup (getModelStrings().sonnet46 crashes).
  let modelStrings: unknown = null
  return {
    // Session identity
    getSessionId: () => 'mock-session-id',
    regenerateSessionId: noop,
    getParentSessionId: () => undefined,
    switchSession: noop,
    onSessionSwitch: () => () => {},

    // CWD / project
    getOriginalCwd: () => '/mock/cwd',
    getSessionProjectDir: () => null,
    getProjectRoot: () => '/mock/project',
    getCwdState: () => '/mock/cwd',
    setCwdState: noop,
    setOriginalCwd: noop,
    setProjectRoot: noop,

    // Direct-connect
    getDirectConnectServerUrl: () => undefined,
    setDirectConnectServerUrl: noop,

    // Duration / cost accumulators
    addToTotalDurationState: noop,
    resetTotalDurationStateAndCost_FOR_TESTS_ONLY: noop,
    addToTotalCostState: noop,
    getTotalCostUSD: () => 0,
    getTotalAPIDuration: () => 0,
    getTotalDuration: () => 0,
    getTotalAPIDurationWithoutRetries: () => 0,
    getTotalToolDuration: () => 0,
    addToToolDuration: noop,

    // Turn stats
    getTurnHookDurationMs: () => 0,
    addToTurnHookDuration: noop,
    resetTurnHookDuration: noop,
    getTurnHookCount: () => 0,
    getTurnToolDurationMs: () => 0,
    resetTurnToolDuration: noop,
    getTurnToolCount: () => 0,
    getTurnClassifierDurationMs: () => 0,
    addToTurnClassifierDuration: noop,
    resetTurnClassifierDuration: noop,
    getTurnClassifierCount: () => 0,

    // Model strings cache (see note above)
    getModelStrings: () => modelStrings,
    setModelStrings: (ms: unknown) => {
      modelStrings = ms
    },

    // Stats store
    getStatsStore: () => ({}),
    setStatsStore: noop,

    // Interaction time
    updateLastInteractionTime: noop,
    flushInteractionTime: noop,

    // Lines changed
    addToTotalLinesChanged: noop,
    getTotalLinesAdded: () => 0,
    getTotalLinesRemoved: () => 0,

    // Token counts
    getTotalInputTokens: () => 0,
    getTotalOutputTokens: () => 0,
    getTotalCacheReadInputTokens: () => 0,
    getTotalCacheCreationInputTokens: () => 0,
    getTotalWebSearchRequests: () => 0,
    getTurnOutputTokens: () => 0,
    getCurrentTurnTokenBudget: () => null,

    // API request state. Faithful set/get pair (not noop/null): production
    // code under test clears or retains this slot (postCompactCleanup), and
    // this mock leaks process-globally into those tests when another file
    // registers it first — a noop stub would make their assertions vacuous.
    setLastAPIRequest: (params: unknown) => {
      lastAPIRequest = params
    },
    getLastAPIRequest: () => lastAPIRequest,

    // Various getters (add as needed)
    getIsNonInteractiveSession: () => false,
    getSdkAgentProgressSummariesEnabled: () => false,
    addSlowOperation: noop,
  }
}

/**
 * Complete-surface factory with per-file overrides. Real exports missing from
 * the hand-tuned base are auto-filled (functions -> () => undefined, values
 * copied), so a caller can never install a partial surface by accident.
 */
export function stateMockWith(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return () => {
    const base = baseStateMock() as Record<string, unknown>
    const full: Record<string, unknown> = { ...base }
    for (const key of Object.keys(realState)) {
      if (key in full) continue
      const realValue = (realState as Record<string, unknown>)[key]
      full[key] = typeof realValue === 'function' ? () => undefined : realValue
    }
    return { ...full, ...overrides }
  }
}

export const stateMock = stateMockWith()
