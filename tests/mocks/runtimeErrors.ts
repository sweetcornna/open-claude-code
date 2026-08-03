/**
 * Shared, complete-surface mock for `src/utils/runtime/errors.js`.
 *
 * Three WebSearchTool suites used to register a hand-rolled two-export stub
 * ({ AbortError, isAbortError }) for this module. Because `mock.module` is
 * process-global and last-write-wins, every later importer in the process saw
 * that two-export surface — and `settings.ts` imports `getErrnoCode` from
 * here, so those suites failed to load the moment anything in their graph
 * touched settings ("Export named 'getErrnoCode' not found").
 *
 * The delegating surface fixes it: every export is the real one unless a
 * suite overrides it, so `AbortError` is also the SAME class the adapters
 * throw — which is what those suites' `instanceof` assertions actually need.
 *
 * Usage:
 *   import { setupRuntimeErrorsMock } from 'tests/mocks/runtimeErrors.js'
 *   const errorsMock = setupRuntimeErrorsMock()   // all-real surface
 *   afterAll(() => errorsMock.reset())
 */

import * as realRuntimeErrors from 'src/utils/runtime/errors.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type RuntimeErrorsOverrides = ModuleOverrides<typeof realRuntimeErrors>

const withExtension = makeSharedModuleMock(
  'src/utils/runtime/errors.js',
  realRuntimeErrors,
)
// Bun keys the registry by specifier text, so a suite importing the
// extensionless form needs its own registration.
const withoutExtension = makeSharedModuleMock(
  'src/utils/runtime/errors',
  realRuntimeErrors,
)

export function setupRuntimeErrorsMock(
  initial: RuntimeErrorsOverrides = {},
): ReturnType<typeof withExtension.setup> {
  const first = withExtension.setup(initial)
  const second = withoutExtension.setup(initial)
  return {
    set: overrides => {
      first.set(overrides)
      second.set(overrides)
    },
    reset: () => {
      first.reset()
      second.reset()
    },
  }
}
