/**
 * Regression test: compaction must release the captured lastAPIRequest.
 *
 * lastAPIRequest holds the full system prompt and every tool schema of the
 * last main-thread query. /clear always released it; before this fix every
 * compact path (manual, auto, reactive, session-memory — they all funnel
 * through runPostCompactCleanup) retained it indefinitely.
 *
 * Subagent compacts must NOT clear it: the slot only ever holds main-thread
 * captures, and a subagent compacting mid-session would otherwise destroy
 * the main thread's diagnostic snapshot.
 *
 * Asserts through the same bootstrap/state.js accessors production uses.
 * Several test files register process-global mock.module replacements for
 * that barrel; Bun patches live bindings, so production and this file always
 * observe the same instance — which is why those mocks must implement
 * setLastAPIRequest/getLastAPIRequest as a faithful pair (tests/mocks/
 * state.ts and share-projectdir's inline mock do), not noop/null.
 */
import { describe, expect, test } from 'bun:test'
import { getLastAPIRequest, setLastAPIRequest } from 'src/bootstrap/state.js'
import { runPostCompactCleanup } from '../postCompactCleanup.js'

const dummyRequest = {
  model: 'claude-sonnet-4-6',
  system: 'a very large system prompt',
  tools: [{ name: 'Bash' }],
} as unknown as NonNullable<ReturnType<typeof getLastAPIRequest>>

describe('runPostCompactCleanup', () => {
  test('clears lastAPIRequest for main-thread compacts', () => {
    setLastAPIRequest(dummyRequest)
    runPostCompactCleanup('repl_main_thread')
    expect(getLastAPIRequest()).toBeNull()

    // undefined querySource is the documented main-thread-only caller shape
    // (/compact, /clear).
    setLastAPIRequest(dummyRequest)
    runPostCompactCleanup()
    expect(getLastAPIRequest()).toBeNull()
  })

  test('retains lastAPIRequest when a subagent compacts', () => {
    setLastAPIRequest(dummyRequest)
    runPostCompactCleanup(
      'agent:some-subagent' as Parameters<typeof runPostCompactCleanup>[0],
    )
    expect(getLastAPIRequest()).toBe(dummyRequest)
    setLastAPIRequest(null)
  })
})
