import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// MACRO is a build-time define (scripts/defines.ts), unset under `bun test`.
// Both services stamp getClaudeCodeUserAgent() onto their requests.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

import { setupConfigMock } from '../../../../tests/mocks/config.js'
import {
  applyDeepSeekAnthropicWire,
  isDeepSeekMirroredApiKey,
} from '../../../utils/model/deepseekWire.js'
import {
  applyOpencodeWire,
  isOpencodeMirroredApiKey,
  setOpencodeRuntimeCredential,
} from '../../../utils/model/opencodeWire.js'
import { isDirectAnthropicApi } from '../../../utils/model/providers.js'
import {
  _resetPolicyLimitsForTesting,
  getPolicyLimitsAuthHeaders,
  isPolicyLimitsEligible,
} from '../index.js'
import { getRemoteSettingsAuthHeaders } from '../../remoteManagedSettings/index.js'
import {
  isRemoteManagedSettingsEligible,
  resetSyncCache,
} from '../../remoteManagedSettings/syncCache.js'

/**
 * The two managed-fetch services — policy limits and remote managed settings —
 * each carry their OWN local auth-header resolver, api-key-first, pointed at
 * api.anthropic.com. This file covers both from one process because they are
 * the same shape and the same hazard; splitting them would only buy a second
 * subprocess spawn.
 *
 * Two claims:
 *
 * 1. In a real mirrored session (DeepSeek or OpenCode), the eligibility gate
 *    already refuses — no request is built at all. That is the status quo and
 *    the reason there is no live leak to fix.
 *
 * 2. The gate decides on ANTHROPIC_BASE_URL while the credential that would
 *    travel is ANTHROPIC_API_KEY. Those are two different signals, so the gate
 *    can open while the key is still mirrored — reset the base URL after a wire
 *    has mirrored itself and it does. The header builders must refuse on their
 *    own, independently of what the gate decided.
 *
 * Runs in its own bun process, for the same reason as
 * utils/auth/__tests__/mirroredCredentialSinks.runner.ts: these assertions are
 * about the REAL auth chain, and `mock.module` is process-global — one other
 * file in the shard stubbing src/utils/auth/auth.js would make every "the key
 * did not travel" claim pass for the wrong reason.
 */

const GENUINE_ANTHROPIC_KEY = 'sk-ant-genuine-user-key'
const DEEPSEEK_KEY = 'sk-deepseek-secret'
const OPENCODE_TOKEN = 'oc-live-access-token'

const ENV_KEYS = [
  'CI',
  'USER_TYPE',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_WIRE_API',
  'OPENCODE_INFERENCE_PLANE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}
const configMock = setupConfigMock()

/** The DeepSeek shape: OPENAI_* configured, mirrored onto ANTHROPIC_*. */
function useDeepSeekMirror(opts: { ownAnthropicKey?: string } = {}): void {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  process.env.OPENAI_API_KEY = DEEPSEEK_KEY
  if (opts.ownAnthropicKey) {
    // Set BEFORE the mirror runs: the wire only claims keys it wrote itself, so
    // a user's own key survives un-mirrored.
    process.env.ANTHROPIC_API_KEY = opts.ownAnthropicKey
  }
  applyDeepSeekAnthropicWire()
}

/** The OpenCode shape on the /messages lane, where it mirrors onto ANTHROPIC_*. */
function useOpencodeMirror(): void {
  process.env.OPENCODE_AUTH_MODE = 'opencode'
  process.env.OPENCODE_BASE_URL = 'https://opencode.ai/zen/v1'
  process.env.OPENCODE_MODEL = 'claude-sonnet-4'
  setOpencodeRuntimeCredential(OPENCODE_TOKEN)
  applyOpencodeWire()
}

/**
 * Anything that re-applies environment after a wire has mirrored itself and
 * puts ANTHROPIC_BASE_URL back to Anthropic's own host without re-running the
 * mirror. The key stays mirrored; only the signal the gate reads changes.
 */
function resetBaseUrlToAnthropic(): void {
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  resetSyncCache()
}

function clearProviderEnv(): void {
  for (const key of ENV_KEYS) {
    if (
      key.startsWith('OPENAI_') ||
      key.startsWith('ANTHROPIC_') ||
      key.startsWith('OPENCODE_')
    ) {
      delete process.env[key]
    }
  }
  setOpencodeRuntimeCredential(undefined)
  // Rebuild both ledgers against the now-empty env so they stop vouching for
  // this file's keys.
  applyDeepSeekAnthropicWire()
  applyOpencodeWire()
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  configMock.set({
    getGlobalConfig: () =>
      ({
        env: { ANTHROPIC_API_KEY: GENUINE_ANTHROPIC_KEY },
      }) as unknown as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
    saveGlobalConfig: (() =>
      undefined) as unknown as typeof import('src/utils/config/config.js').saveGlobalConfig,
    checkHasTrustDialogAccepted: () => true,
  })
})

afterAll(() => {
  configMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  clearProviderEnv()
})

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
  clearProviderEnv()
  _resetPolicyLimitsForTesting()
  resetSyncCache()
  process.env.OCC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-managed-'))
})

describe('the premise', () => {
  test('both wires really do put a third-party secret in ANTHROPIC_API_KEY', () => {
    useDeepSeekMirror()
    expect(process.env.ANTHROPIC_API_KEY).toBe(DEEPSEEK_KEY)
    expect(isDeepSeekMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)

    clearProviderEnv()
    useOpencodeMirror()
    expect(process.env.ANTHROPIC_API_KEY).toBe(OPENCODE_TOKEN)
    expect(isOpencodeMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)
  })
})

describe('the eligibility gate refuses a real mirrored session', () => {
  test('a DeepSeek session is ineligible for both managed fetches', () => {
    useDeepSeekMirror()
    // The gate's own signal: the mirror pointed ANTHROPIC_BASE_URL at DeepSeek.
    expect(isDirectAnthropicApi()).toBe(false)
    expect(isPolicyLimitsEligible()).toBe(false)
    expect(isRemoteManagedSettingsEligible()).toBe(false)
  })

  test('an OpenCode /messages session is ineligible for both managed fetches', () => {
    useOpencodeMirror()
    expect(isDirectAnthropicApi()).toBe(false)
    expect(isPolicyLimitsEligible()).toBe(false)
    expect(isRemoteManagedSettingsEligible()).toBe(false)
  })
})

describe('the header builders refuse on their own', () => {
  test('the gate opens when ANTHROPIC_BASE_URL is reset under a DeepSeek mirror', () => {
    // Not a bug report about isDirectAnthropicApi() — it is answering its own
    // question correctly. It is the demonstration that "the gate refuses" and
    // "the key cannot travel" are two separate facts, and only the second one
    // is load-bearing.
    useDeepSeekMirror()
    resetBaseUrlToAnthropic()

    expect(isDirectAnthropicApi()).toBe(true)
    expect(isPolicyLimitsEligible()).toBe(true)
    expect(isRemoteManagedSettingsEligible()).toBe(true)
    // ...and the credential is still DeepSeek's.
    expect(isDeepSeekMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)
  })

  test('policy limits does not send a mirrored DeepSeek key', () => {
    useDeepSeekMirror()
    resetBaseUrlToAnthropic()

    const auth = getPolicyLimitsAuthHeaders()
    expect(JSON.stringify(auth.headers)).not.toContain(DEEPSEEK_KEY)
    // No OAuth token in this session either, so there is nothing to fall
    // through to and the fetch is skipped with skipRetry.
    expect(auth.error).toBeTruthy()
  })

  test('remote managed settings does not send a mirrored DeepSeek key', () => {
    useDeepSeekMirror()
    resetBaseUrlToAnthropic()

    const auth = getRemoteSettingsAuthHeaders()
    expect(JSON.stringify(auth.headers)).not.toContain(DEEPSEEK_KEY)
    expect(auth.error).toBeTruthy()
  })

  test('neither service sends a mirrored OpenCode access token', () => {
    useOpencodeMirror()
    resetBaseUrlToAnthropic()

    // Worth its own case: an OpenCode credential is a live OAuth access token
    // that is deliberately never written to disk, so handing it to a third
    // party is strictly worse than handing over a scoped API key.
    expect(isOpencodeMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)
    for (const auth of [
      getPolicyLimitsAuthHeaders(),
      getRemoteSettingsAuthHeaders(),
    ]) {
      expect(JSON.stringify(auth.headers)).not.toContain(OPENCODE_TOKEN)
      expect(auth.error).toBeTruthy()
    }
  })
})

describe('a genuine Anthropic key is unaffected', () => {
  test('both services still authenticate with the user own key', () => {
    // Same session shape — DeepSeek configured through OPENAI_* — but the user
    // brought their own ANTHROPIC_API_KEY, so the wire never claimed it. The
    // predicate here must be isThirdPartyMirroredApiKey, not
    // isOccConfiguredAnthropicApiKey inverted: this key is BOTH occ-configured
    // and genuinely Anthropic's, and inverting the other predicate would
    // refuse it.
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })
    resetBaseUrlToAnthropic()

    expect(getPolicyLimitsAuthHeaders()).toEqual({
      headers: { 'x-api-key': GENUINE_ANTHROPIC_KEY },
    })
    expect(getRemoteSettingsAuthHeaders()).toEqual({
      headers: { 'x-api-key': GENUINE_ANTHROPIC_KEY },
    })
  })

  test('a plain Anthropic session is untouched', () => {
    process.env.ANTHROPIC_API_KEY = GENUINE_ANTHROPIC_KEY

    expect(isDirectAnthropicApi()).toBe(true)
    expect(isPolicyLimitsEligible()).toBe(true)
    expect(isRemoteManagedSettingsEligible()).toBe(true)
    expect(getPolicyLimitsAuthHeaders().headers['x-api-key']).toBe(
      GENUINE_ANTHROPIC_KEY,
    )
    expect(getRemoteSettingsAuthHeaders().headers['x-api-key']).toBe(
      GENUINE_ANTHROPIC_KEY,
    )
  })
})
