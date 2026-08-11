import { describe, expect, test } from 'bun:test'
import {
  OPENCODE_AUTH_MODE_ENV,
  OPENCODE_BASE_URL_ENV,
  OPENCODE_MODEL_ENV,
  OPENCODE_TIER_ENVS,
  OPENCODE_WIRE_API_ENV,
} from 'src/utils/model/opencodeWire.js'
import { OPENCODE_API_KEY_ENV } from 'src/services/auth/opencode/constants.js'
import { ALL_PROFILE_ENV_KEYS, PROFILE_ENV_KEYS } from '../envKeys.js'

/**
 * The OPENCODE_* family in the profile table.
 *
 * The table's contract is "activation clears the union of every family before
 * applying the target's env", so a key missing from it is not an omission — it
 * survives the switch and keeps steering the next provider. For OpenCode that
 * means a session switched away from Zen still carrying OPENCODE_AUTH_MODE,
 * which is the single key getAPIProvider() reads before anything else.
 */

const REQUIRED = [
  OPENCODE_AUTH_MODE_ENV,
  OPENCODE_BASE_URL_ENV,
  OPENCODE_MODEL_ENV,
  OPENCODE_WIRE_API_ENV,
  OPENCODE_API_KEY_ENV,
  ...OPENCODE_TIER_ENVS,
]

describe('PROFILE_ENV_KEYS.opencode', () => {
  test('covers every key the wire module and the credential layer read', () => {
    // Imported from their own modules rather than spelled out again: the names
    // are the contract between the mirror and this table, and a literal copy
    // here would go stale silently — the failure being a key nothing clears.
    expect(PROFILE_ENV_KEYS.opencode).toEqual(expect.arrayContaining(REQUIRED))
  })

  test('flows into the union, and therefore into logout', () => {
    for (const key of REQUIRED) {
      expect(ALL_PROFILE_ENV_KEYS).toContain(key)
    }
  })

  test('is deduped', () => {
    expect(new Set(ALL_PROFILE_ENV_KEYS).size).toBe(ALL_PROFILE_ENV_KEYS.length)
  })

  test('no other family claims an OPENCODE_ key', () => {
    // A key in two rows is cleared twice and captured into the wrong profile.
    for (const [family, keys] of Object.entries(PROFILE_ENV_KEYS)) {
      if (family === 'opencode') continue
      expect(keys.filter(key => key.startsWith('OPENCODE_'))).toEqual([])
    }
  })
})
