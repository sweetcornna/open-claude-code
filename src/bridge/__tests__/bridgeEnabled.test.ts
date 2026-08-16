import { feature } from 'bun:bundle'
import { afterEach, describe, expect, test } from 'bun:test'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getBridgeDisabledReason,
  isBridgeEnabled,
  isBridgeEnabledBlocking,
} from '../bridgeEnabled.js'

/**
 * `feature()` is resolved by the Bun compiler, not at runtime, so it cannot be
 * mocked — under a plain `bun test` BRIDGE_MODE is compiled out and every
 * answer here is "not available in this build". Run
 * `bun test --feature BRIDGE_MODE src/bridge` to exercise the shipped
 * configuration; both shapes are asserted so neither run is vacuous.
 */
const BRIDGE_MODE_COMPILED_IN = feature('BRIDGE_MODE') ? true : false
const NOT_IN_BUILD = 'Remote Control is not available in this build.'

// tests/preload.ts clears these for the whole run; each test only has to undo
// what it set.
afterEach(() => {
  delete process.env.OCC_REMOTE_CONTROL_URL
  delete process.env.CLAUDE_BRIDGE_BASE_URL
})

describe('Remote Control entitlement', () => {
  // The whole point of the default server: an unconfigured occ must not be
  // gated on a claude.ai subscription plus a first-party GrowthBook flag that
  // occ never fetches (1P GrowthBook is opt-in-off here).
  test('is enabled with no configuration at all', async () => {
    if (!BRIDGE_MODE_COMPILED_IN) {
      expect(isBridgeEnabled()).toBe(false)
      expect(await getBridgeDisabledReason()).toBe(NOT_IN_BUILD)
      return
    }
    expect(isBridgeEnabled()).toBe(true)
    expect(await isBridgeEnabledBlocking()).toBe(true)
    expect(await getBridgeDisabledReason()).toBeNull()
  })

  test('is enabled for an explicitly configured server', async () => {
    process.env.OCC_REMOTE_CONTROL_URL = 'https://rcs.example.test'
    if (!BRIDGE_MODE_COMPILED_IN) {
      expect(isBridgeEnabled()).toBe(false)
      return
    }
    expect(isBridgeEnabled()).toBe(true)
    expect(await getBridgeDisabledReason()).toBeNull()
  })

  // The claude.ai branch is still reachable, and still refuses without a
  // subscription — it is opt-in now rather than the unavoidable default.
  test('still applies the claude.ai checks when pointed at Anthropic', async () => {
    process.env.OCC_REMOTE_CONTROL_URL = getOauthConfig().BASE_API_URL
    expect(isBridgeEnabled()).toBe(false)
    expect(await getBridgeDisabledReason()).toContain(
      BRIDGE_MODE_COMPILED_IN ? 'claude.ai' : NOT_IN_BUILD,
    )
  })
})
