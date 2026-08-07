/**
 * Shared complete-surface mock for `src/services/api/claude.js`.
 *
 * The module is the main-loop API client: ~25 value exports, several of them
 * pure helpers (`getCacheControl`, `accumulateUsage`, `getMaxOutputTokensForModel`)
 * that other suites in the same shard legitimately call for real. A hand-rolled
 * `mock.module('…/claude.js', () => ({ queryHaiku }))` erases all of them for
 * every file loaded afterwards — the process-global last-write-wins hazard
 * documented in tests/mocks/sharedModuleMock.ts.
 *
 * Only the network-facing entry points normally need overriding
 * (`queryHaiku`, `queryWithModel`, `queryModelWithStreaming`,
 * `queryModelWithoutStreaming`, `verifyApiKey`); everything else delegates to
 * the real implementation.
 *
 * Usage:
 *   import { setupApiClaudeMock } from '../../../../tests/mocks/apiClaude.js'
 *   const apiClaudeMock = setupApiClaudeMock({ queryHaiku: async () => stub })
 *   afterAll(() => apiClaudeMock.reset())
 */

import * as realApiClaude from 'src/services/api/claude.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type ApiClaudeOverrides = ModuleOverrides<typeof realApiClaude>

const shared = makeSharedModuleMock('src/services/api/claude.js', realApiClaude)

export function setupApiClaudeMock(
  initial: ApiClaudeOverrides = {},
): ReturnType<typeof shared.setup> {
  return shared.setup(initial)
}
