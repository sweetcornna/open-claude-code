/**
 * Shared COMPLETE mock for src/bootstrap/state.ts
 *
 * The real module is NOT actually fail-fast: STATE is eagerly initialized at
 * module load with working in-memory defaults (random sessionId, cwd resolved
 * from process.cwd(), empty collections) and has zero disk/network side
 * effects — resetStateForTests() exists precisely because tests exercise the
 * real container. So this mock DELEGATES every export to the real
 * implementation at call time unless the caller overrode it. That keeps two
 * classes of test working at once, in any file order:
 *
 *  - suites that install this mock get their overrides;
 *  - suites that use the REAL state (claudemd.projectDirs.test.ts,
 *    autonomyRuns.test.ts call setOriginalCwd/resetStateForTests and read the
 *    results back) still work after a mocking file ran first, because the
 *    non-overridden surface IS the real module. The previous
 *    hand-stubbed base (noop setters, '/mock/cwd' getters, `() => undefined`
 *    auto-fill) silently broke them — order-dependent, direction depends on
 *    Bun's file order — and crashed iterating consumers
 *    ("Spread syntax requires ...iterable" in sandbox-adapter).
 *
 * Two keys stay pinned (overridable) because their real values are
 * environment-shaped and mock-installing suites historically relied on the
 * stable ones: getSessionId ('mock-session-id' instead of a random UUID) and
 * getIsNonInteractiveSession (false regardless of the container's
 * isInteractive default).
 *
 * ── The getIsNonInteractiveSession pin is a landmine for OTHER files ──
 *
 * `mock.module` is process-global, last-write-wins, and this mock has no
 * teardown: once any file installs it, EVERY later file in the same shard
 * sees the pins. The real container defaults to `isInteractive: false`
 * (container.ts), so the real `getIsNonInteractiveSession()` returns TRUE in
 * tests; the pin flips that to false, i.e. "this is an interactive session".
 *
 * That flip is not cosmetic — it changes trust-gated control flow. The one
 * that has actually bitten: `shouldSkipHookDueToTrust()` (utils/hooks/
 * config.ts) short-circuits to "run the hook" in non-interactive sessions,
 * but in interactive ones requires `checkHasTrustDialogAccepted()`. A hook
 * test running against a tmpdir has no persisted trust, so with the pin
 * installed by an unrelated earlier file every hook silently no-ops and the
 * suite fails with empty results and no error — and only in whatever file
 * order Bun happens to pick (i.e. typically only on Linux CI).
 *
 * So: if the code under test reads session interactivity (or the session id)
 * from the container — trust gating, hook execution, print-vs-REPL branches —
 * use `stateMockDelegating` / `stateMockWith(overrides, { pinSessionDefaults:
 * false })`, which delegates those two to the real module like everything
 * else, and set them explicitly via the real setters (`setIsInteractive`,
 * `switchSession`) if the suite needs a specific value. Keep the pinned
 * default only when the suite genuinely just wants a stable session id.
 *
 * Usage:
 *   import { stateMockWith } from '../../../tests/mocks/state.js'
 *   mock.module('src/bootstrap/state.ts', stateMockWith({
 *     getSessionId: () => 'my-suite-session',
 *   }))
 *
 * `stateMock` (no overrides) is kept for existing consumers.
 */

import * as realState from 'src/bootstrap/state.js'

const pinnedBase: Record<string, unknown> = {
  getSessionId: () => 'mock-session-id',
  getIsNonInteractiveSession: () => false,
}

export type StateMockOptions = {
  /**
   * Keep the environment-shaped pins (getSessionId,
   * getIsNonInteractiveSession). Defaults to true so existing consumers are
   * unaffected. Pass false to delegate those two to the real container as
   * well — see the landmine note above.
   */
  pinSessionDefaults?: boolean
}

/**
 * Complete-surface factory with per-file overrides. Every real export not
 * overridden (and not pinned above) delegates to the real implementation at
 * call time, so a caller can never install a partial or behavior-drifting
 * surface by accident.
 */
export function stateMockWith(
  overrides: Record<string, unknown> = {},
  options: StateMockOptions = {},
): () => Record<string, unknown> {
  const usePins = options.pinSessionDefaults !== false
  return () => {
    const surface: Record<string, unknown> = {}
    for (const key of Object.keys(realState)) {
      const realValue = (realState as Record<string, unknown>)[key]
      if (typeof realValue !== 'function') {
        surface[key] = realValue
        continue
      }
      surface[key] = (...args: unknown[]): unknown => {
        const pinned = usePins ? pinnedBase[key] : undefined
        const impl = (overrides[key] ?? pinned ?? realValue) as (
          ...a: unknown[]
        ) => unknown
        return impl(...args)
      }
    }
    // Preserve overrides that don't exist on the real module (historical
    // helpers some suites add); real keys already delegate above.
    for (const key of Object.keys(overrides)) {
      if (!(key in surface)) surface[key] = overrides[key]
    }
    return surface
  }
}

/**
 * Fully delegating variant: no pins at all, so getSessionId and
 * getIsNonInteractiveSession answer from the real container (and follow the
 * real setters). Use this whenever the code under test is trust-gated or
 * interactivity-gated; see the landmine note at the top of this file.
 */
export function stateMockDelegating(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return stateMockWith(overrides, { pinSessionDefaults: false })
}

export const stateMock = stateMockWith()
