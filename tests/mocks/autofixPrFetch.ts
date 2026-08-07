/**
 * Shared complete-surface mock for src/commands/autofix-pr/prFetch.js.
 *
 * prFetch is the `gh` CLI spawn layer; the launchAutofixPr suite stubs it so
 * the monitor loop never shells out. The pure decision matrix it wraps
 * (prOutcomeCheck.ts) is deliberately NOT mocked, so its own tests stay honest
 * — but the stub installed here is process-global, hence the complete
 * delegating surface. See tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupAutofixPrFetchMock } from '<relative>/tests/mocks/autofixPrFetch.js'
 *   const m = setupAutofixPrFetchMock({ fetchPrHeadSha: spy })
 *   afterAll(() => m.reset())
 */

import * as realPrFetch from 'src/commands/autofix-pr/prFetch.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type AutofixPrFetchOverrides = ModuleOverrides<typeof realPrFetch>

const shared = makeSharedModuleMock(
  'src/commands/autofix-pr/prFetch.js',
  realPrFetch,
)

export function setupAutofixPrFetchMock(
  initial: AutofixPrFetchOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
