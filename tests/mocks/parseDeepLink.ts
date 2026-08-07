/**
 * Shared complete-surface mock for src/utils/deepLink/parseDeepLink.js.
 *
 * The module is pure (URI string in, action object out) with no import-time
 * side effects, so most suites need no mock at all — what they do need is a
 * spy, to assert which URI reached the parser.
 *
 * A hand-rolled `{ parseDeepLink }` surface is not harmless here: the module
 * also re-exports `DEEP_LINK_PROTOCOL`, and `registerProtocol.ts` imports it.
 * Erasing it turns any later import of registerProtocol in the same shard
 * into `SyntaxError: Export named 'DEEP_LINK_PROTOCOL' not found` — observed,
 * not hypothetical. See tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupParseDeepLinkMock } from '<relative>/tests/mocks/parseDeepLink.js'
 *   const spy = mock((uri: string) => ({ query: 'hello' }))
 *   const m = setupParseDeepLinkMock({ parseDeepLink: spy })
 *   afterAll(() => m.reset())
 */

import * as realParseDeepLink from 'src/utils/deepLink/parseDeepLink.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ParseDeepLinkOverrides = ModuleOverrides<typeof realParseDeepLink>

const shared = makeSharedModuleMock(
  'src/utils/deepLink/parseDeepLink.js',
  realParseDeepLink,
)

export function setupParseDeepLinkMock(initial: ParseDeepLinkOverrides = {}): {
  set(overrides: ParseDeepLinkOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
