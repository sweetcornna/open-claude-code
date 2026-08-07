/**
 * Shared complete-surface mock for src/utils/text/intl.js.
 *
 * The module is a lazy cache of Intl instances with no import-time side
 * effects, so the all-real surface is free; what suites actually need to
 * control is `getSystemLocaleLanguage`, whose real value depends on the
 * machine running the tests. Hand-rolling that one export as an inline
 * `mock.module` surface erases the segmenter/format helpers for every file
 * loaded afterwards in the shard — Bun's mock registry is process-global and
 * last-write-wins. See tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupIntlMock } from '<relative>/tests/mocks/intl.js'
 *   const m = setupIntlMock()
 *   beforeAll(() => m.set({ getSystemLocaleLanguage: () => 'zh' }))
 *   afterAll(() => m.reset())
 */

import * as realIntl from 'src/utils/text/intl.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type IntlOverrides = ModuleOverrides<typeof realIntl>

const shared = makeSharedModuleMock('src/utils/text/intl.js', realIntl)

export function setupIntlMock(initial: IntlOverrides = {}): {
  set(overrides: IntlOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
