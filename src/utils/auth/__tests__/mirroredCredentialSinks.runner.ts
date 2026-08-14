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
// submitTranscriptShare reads MACRO.VERSION while building its payload.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

import { setupAxiosMock } from '../../../../tests/mocks/axios'
import { setupConfigMock } from '../../../../tests/mocks/config.js'
import {
  applyDeepSeekAnthropicWire,
  isDeepSeekMirroredApiKey,
} from '../../model/deepseekWire.js'
import {
  getAuthHeaders,
  getFirstPartyTelemetryAuthHeaders,
} from '../../network/http.js'
import {
  isBlockedByMirroredCredential,
  MIRRORED_CREDENTIAL_NOTICE,
} from '../firstPartyDataSharing.js'
import { submitFeedback } from '../../../components/Feedback.js'
import { submitTranscriptShare } from '../../../components/FeedbackSurvey/submitTranscriptShare.js'
import { fetchAndStoreClaudeCodeFirstTokenDate } from '../../../services/api/firstTokenDate.js'
import { getOauthProfileFromApiKey } from '../../../services/oauth/getOauthProfile.js'
import {
  _resetMetricsOptOutCacheForTesting,
  checkMetricsEnabled,
} from '../../../services/api/metricsOptOut.js'
import { fetchUtilization } from '../../../services/api/usage.js'
import {
  getGroveNoticeConfig,
  getGroveSettings,
  markGroveNoticeViewed,
  updateGroveSettings,
} from '../../../services/api/grove.js'

/**
 * The deliverable: in a session whose ANTHROPIC_API_KEY holds a credential
 * mirrored there by a provider wire, nothing occ addresses to api.anthropic.com
 * on its own behalf carries that credential — while inference, which is
 * addressed to the provider's own Anthropic-compatible endpoint, still does.
 *
 * Runs in its own bun process. See mirroredCredentialSinks.test.ts for why.
 */

const GENUINE_ANTHROPIC_KEY = 'sk-ant-genuine-user-key'
const DEEPSEEK_KEY = 'sk-deepseek-secret'

const ENV_KEYS = [
  'CI',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'USER_TYPE',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

const configMock = setupConfigMock()
const axiosHandle = setupAxiosMock()

/** Every request that reached the (mocked) network, in order. */
type RecordedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}
let requests: RecordedRequest[] = []

function record(method: string) {
  return (url: string, ...rest: unknown[]) => {
    // axios.get(url, config) but axios.post/patch(url, data, config)
    const hasBody = method !== 'get'
    const body = hasBody ? rest[0] : undefined
    const config = (hasBody ? rest[1] : rest[0]) as
      | { headers?: Record<string, string> }
      | undefined
    requests.push({ method, url, headers: config?.headers ?? {}, body })
    return Promise.resolve({
      status: 200,
      data: {},
      headers: {},
      statusText: 'OK',
      config,
    })
  }
}

function anthropicRequests(): RecordedRequest[] {
  return requests.filter(r => r.url.includes('anthropic.com'))
}

/** Assert no recorded request carried the third party's secret, anywhere. */
function expectNoDeepSeekKeyOnTheWire(): void {
  for (const req of requests) {
    expect(JSON.stringify(req.headers)).not.toContain(DEEPSEEK_KEY)
  }
}

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

function clearProviderEnv(): void {
  for (const key of ENV_KEYS) {
    if (key.startsWith('OPENAI_') || key.startsWith('ANTHROPIC_')) {
      delete process.env[key]
    }
  }
  // Rebuild the mirror's ledger against the now-empty env so it stops vouching
  // for this file's keys.
  applyDeepSeekAnthropicWire()
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]

  axiosHandle.stubs.get = record('get')
  axiosHandle.stubs.post = record('post')
  axiosHandle.stubs.patch = record('patch')
  axiosHandle.useStubs = true

  configMock.set({
    getGlobalConfig: () =>
      ({
        // Vouches for GENUINE_ANTHROPIC_KEY as a key occ configured, so the
        // auth chain resolves it without reaching the keychain.
        env: { ANTHROPIC_API_KEY: GENUINE_ANTHROPIC_KEY },
        // getOauthProfileFromApiKey needs an account uuid to get as far as
        // building a request at all.
        oauthAccount: { accountUuid: 'account-under-test' },
      }) as unknown as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
    saveGlobalConfig: (() =>
      undefined) as unknown as typeof import('src/utils/config/config.js').saveGlobalConfig,
    checkHasTrustDialogAccepted: () => true,
  })
})

afterAll(() => {
  axiosHandle.useStubs = false
  configMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  applyDeepSeekAnthropicWire()
})

beforeEach(() => {
  requests = []
  for (const key of ENV_KEYS) delete process.env[key]
  clearProviderEnv()
  _resetMetricsOptOutCacheForTesting()
  getGroveSettings.cache.clear?.()
  getGroveNoticeConfig.cache.clear?.()
  process.env.OCC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-mirror-'))
})

describe('the premise', () => {
  test('the DeepSeek wire really does put its key in ANTHROPIC_API_KEY', () => {
    useDeepSeekMirror()
    expect(process.env.ANTHROPIC_API_KEY).toBe(DEEPSEEK_KEY)
    expect(isDeepSeekMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)
  })

  test('inference auth is unchanged — the mirrored key is still sent', () => {
    useDeepSeekMirror()
    // getAuthHeaders() serves requests bound for ANTHROPIC_BASE_URL, which the
    // wire has pointed at DeepSeek. Refusing the key here would 401 every
    // DeepSeek and OpenCode session.
    expect(getAuthHeaders().headers['x-api-key']).toBe(DEEPSEEK_KEY)
    expect(getFirstPartyTelemetryAuthHeaders().error).toBeTruthy()
  })

  test('isBlockedByMirroredCredential distinguishes mirrored from genuine', () => {
    useDeepSeekMirror()
    expect(isBlockedByMirroredCredential()).toBe(true)

    // Same session shape, but ANTHROPIC_API_KEY holds the user's own key.
    clearProviderEnv()
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })
    expect(isBlockedByMirroredCredential()).toBe(false)
  })

  test('no credential at all is not reported as a mirrored credential', () => {
    // The distinction matters: every caller has its own "no auth" branch, and
    // conflating the two would make them all tell the user they are on a
    // third-party provider when they are simply logged out.
    //
    // Resolving no credential is also the case where the auth chain *throws*
    // rather than returning an error (getAnthropicApiKeyWithSource does that
    // under CI/NODE_ENV=test, which is exactly this process). The predicate
    // must absorb it: it is called before the try block in both /bug and
    // transcript sharing, so letting it propagate would turn "logged out" into
    // an unhandled rejection.
    expect(() => isBlockedByMirroredCredential()).not.toThrow()
    expect(isBlockedByMirroredCredential()).toBe(false)
  })
})

describe('transcript-bearing sinks refuse to send', () => {
  test('submitTranscriptShare makes no request and says why', async () => {
    useDeepSeekMirror()

    const result = await submitTranscriptShare(
      [
        {
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'my private prompt' },
        } as never,
      ],
      'frustration',
      'appearance-1',
    )

    expect(result.success).toBe(false)
    expect(result.blockedReason).toBe(MIRRORED_CREDENTIAL_NOTICE)
    expect(requests).toEqual([])
  })

  test('/bug makes no request and reports the reason to the dialog', async () => {
    useDeepSeekMirror()

    const result = await submitFeedback({
      latestAssistantMessageId: null,
      message_count: 1,
      datetime: '2026-08-13T00:00:00.000Z',
      description: 'something broke',
      platform: 'darwin',
      gitRepo: false,
      version: 'test',
      transcript: [
        {
          type: 'user',
          uuid: 'u1',
          message: { role: 'user', content: 'my private prompt' },
        } as never,
      ],
    })

    expect(result.success).toBe(false)
    // blockedReason, not the generic failure: the dialog renders this verbatim,
    // and "Could not submit feedback. Please try again later." would send the
    // user round a loop that can never succeed.
    expect(result.blockedReason).toBe(MIRRORED_CREDENTIAL_NOTICE)
    expect(requests).toEqual([])
  })

  test('submitTranscriptShare still works for a genuine Anthropic key', async () => {
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    const result = await submitTranscriptShare(
      [],
      'frustration',
      'appearance-1',
    )

    expect(result.blockedReason).toBeUndefined()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(
      'https://api.anthropic.com/api/claude_code_shared_session_transcripts',
    )
    expect(requests[0]!.headers['x-api-key']).toBe(GENUINE_ANTHROPIC_KEY)
  })
})

describe('background first-party sinks fail closed', () => {
  test('the metrics opt-out probe does not authenticate with the mirrored key', async () => {
    useDeepSeekMirror()

    const status = await checkMetricsEnabled()

    // hasError, not enabled:false-without-error — the caller must not persist
    // this as a real answer from the organization.
    expect(status).toEqual({ enabled: false, hasError: true })
    expect(anthropicRequests()).toEqual([])
    expectNoDeepSeekKeyOnTheWire()
  })

  test('the metrics opt-out probe still runs for a genuine Anthropic key', async () => {
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    await checkMetricsEnabled()

    const probes = requests.filter(r => r.url.includes('metrics_enabled'))
    expect(probes).toHaveLength(1)
    expect(probes[0]!.headers['x-api-key']).toBe(GENUINE_ANTHROPIC_KEY)
  })

  test('the post-login first-token-date fetch is skipped', async () => {
    useDeepSeekMirror()

    await fetchAndStoreClaudeCodeFirstTokenDate()

    expect(anthropicRequests()).toEqual([])
    expectNoDeepSeekKeyOnTheWire()
  })

  test('the startup subscription-switch probe is skipped', async () => {
    useDeepSeekMirror()

    await expect(getOauthProfileFromApiKey()).resolves.toBeUndefined()
    expect(anthropicRequests()).toEqual([])
    expectNoDeepSeekKeyOnTheWire()
  })

  test('the startup subscription-switch probe still runs for a genuine key', async () => {
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    await getOauthProfileFromApiKey()

    const probes = requests.filter(r => r.url.includes('claude_cli_profile'))
    expect(probes).toHaveLength(1)
    expect(probes[0]!.headers['x-api-key']).toBe(GENUINE_ANTHROPIC_KEY)
  })
})

describe('Anthropic-account-only features', () => {
  test('all four Grove requests refuse the mirrored key', async () => {
    useDeepSeekMirror()

    await getGroveSettings()
    await getGroveNoticeConfig()
    await markGroveNoticeViewed()
    await updateGroveSettings(true)

    expect(anthropicRequests()).toEqual([])
    expectNoDeepSeekKeyOnTheWire()
  })

  test('Grove still reaches the API with a genuine Anthropic key', async () => {
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    await getGroveSettings()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toContain('/api/oauth/account/settings')
    expect(requests[0]!.headers['x-api-key']).toBe(GENUINE_ANTHROPIC_KEY)
  })

  test('the subscription-usage query answers empty instead of asking Anthropic', async () => {
    useDeepSeekMirror()

    // isClaudeAISubscriber() is false in this session — isAnthropicAuthEnabled()
    // sees OPENAI_BASE_URL — so there is no Anthropic subscription to report on.
    await expect(fetchUtilization()).resolves.toEqual({})
    expect(anthropicRequests()).toEqual([])
    expectNoDeepSeekKeyOnTheWire()
  })
})
