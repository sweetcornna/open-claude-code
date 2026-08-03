/**
 * Factory for shared, complete-surface module mocks.
 *
 * Bun's `mock.module` is process-global and last-write-wins. When several test
 * files mock the same module with hand-rolled PARTIAL surfaces, whichever file
 * ran last poisons every later import in the process: exports missing from its
 * surface become `undefined` (or "Export not found" at load), and hand-copied
 * "real" fallbacks drift from the actual implementation over time. Because the
 * test-file order differs between macOS and Linux, the breakage only shows up
 * on CI — the classic order-dependent flaky suite.
 *
 * This factory fixes the pattern: every export of the mocked module DELEGATES
 * to the real implementation at call time unless the current suite installed
 * an override. All writers produce the same complete surface, so last-write-
 * wins becomes harmless, and fallbacks can never drift because they ARE the
 * real functions.
 *
 * Per-module wrappers live next to this file (envUtils.ts, growthbook.ts).
 */

import { mock } from 'bun:test'

type AnyModule = Record<string, unknown>

export type ModuleOverrides<M extends AnyModule> = {
  // Callable exports accept a plain function (some real exports are memoized
  // and carry a .cache property; overrides shouldn't have to replicate that).
  [K in keyof M]?: M[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : M[K]
}

export type SharedModuleMock<M extends AnyModule> = {
  /**
   * Install the mock (idempotent) and set this suite's overrides.
   * Whole-map semantics: replaces any previous suite's overrides.
   */
  setup(initial?: ModuleOverrides<M>): {
    set(overrides: ModuleOverrides<M>): void
    /** Drop all overrides — every export delegates to the real module again. */
    reset(): void
  }
}

function isClass(value: unknown): boolean {
  return (
    typeof value === 'function' &&
    /^class[\s{]/.test(Function.prototype.toString.call(value))
  )
}

export function makeSharedModuleMock<M extends AnyModule>(
  specifier: string,
  real: M,
): SharedModuleMock<M> {
  const state: { overrides: ModuleOverrides<M> } = { overrides: {} }

  function buildSurface(): AnyModule {
    const surface: AnyModule = {}
    for (const key of Object.keys(real) as Array<keyof M & string>) {
      const realValue = real[key]
      if (typeof realValue !== 'function') {
        surface[key] = realValue
        continue
      }
      // Classes are functions too, but wrapping one in a delegating arrow
      // breaks `new` and `instanceof` (the wrapper has no usable prototype).
      // Exported error classes are the common case — a suite that mocks
      // errors.js still needs `e instanceof AbortError` to hold — so classes
      // are passed through as-is. Overriding a class export is not supported;
      // no caller has ever needed it.
      if (isClass(realValue)) {
        surface[key] = realValue
        continue
      }
      const delegating = (...args: unknown[]): unknown => {
        const override = state.overrides[key]
        const impl = (override ?? realValue) as (...a: unknown[]) => unknown
        return impl(...args)
      }
      // Forward memoization caches (e.g. lodash-memoized getClaudeConfigHomeDir)
      // so consumers calling `.cache.clear()` keep working.
      const cache = (realValue as { cache?: unknown }).cache
      surface[key] =
        cache === undefined ? delegating : Object.assign(delegating, { cache })
    }
    return surface
  }

  return {
    setup(initial = {}) {
      state.overrides = initial
      mock.module(specifier, buildSurface)
      return {
        set: overrides => {
          state.overrides = overrides
        },
        reset: () => {
          state.overrides = {}
        },
      }
    },
  }
}
