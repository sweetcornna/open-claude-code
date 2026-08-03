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
 * Usage:
 *   import { stateMockWith } from '../../../tests/mocks/state.js'
 *   mock.module('src/bootstrap/state.js', stateMockWith({
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

/**
 * Complete-surface factory with per-file overrides. Every real export not
 * overridden (and not pinned above) delegates to the real implementation at
 * call time, so a caller can never install a partial or behavior-drifting
 * surface by accident.
 */
export function stateMockWith(
  overrides: Record<string, unknown> = {},
): () => Record<string, unknown> {
  return () => {
    const surface: Record<string, unknown> = {}
    for (const key of Object.keys(realState)) {
      const realValue = (realState as Record<string, unknown>)[key]
      if (typeof realValue !== 'function') {
        surface[key] = realValue
        continue
      }
      surface[key] = (...args: unknown[]): unknown => {
        const impl = (overrides[key] ?? pinnedBase[key] ?? realValue) as (
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

export const stateMock = stateMockWith()
