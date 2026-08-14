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

// MACRO is a build-time define (scripts/defines.ts). Unset under `bun test`,
// and both the 1P logger and getCoreUserData read MACRO.VERSION.
;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
  VERSION: 'test',
}

import { clearCache, setPolyfills } from '@growthbook/growthbook'
import { setupAxiosMock } from '../../../../tests/mocks/axios'
import { setupConfigMock } from '../../../../tests/mocks/config.js'
import { setupUserMock } from '../../../../tests/mocks/user.js'
import {
  applyDeepSeekAnthropicWire,
  isDeepSeekMirroredApiKey,
} from '../../../utils/model/deepseekWire.js'
import {
  getAuthHeaders,
  getFirstPartyTelemetryAuthHeaders,
} from '../../../utils/network/http.js'
import {
  initialize1PEventLogging,
  is1PEventLoggingEnabled,
  logEventTo1P,
  logGrowthBookExperimentTo1P,
  shutdown1PEventLogging,
} from '../firstPartyEventLogger.js'
import {
  getFeatureValue_CACHED_MAY_BE_STALE,
  initializeGrowthBook,
  refreshGrowthBookFeatures,
  resetGrowthBook,
  setupPeriodicGrowthBookRefresh,
  stopPeriodicGrowthBookRefresh,
} from '../growthbook.js'

/**
 * The deliverable this file exists for: with nothing configured, occ makes no
 * request to api.anthropic.com for feature gates or event logging, and no
 * credential of any kind leaves the machine on that account.
 *
 * Before this change both were on for everyone who had not set
 * DISABLE_TELEMETRY: GrowthBook fetched an experiment payload and cached it to
 * ~/.occ.json where it steered occ's behaviour indefinitely, and the 1P
 * exporter POSTed usage events authenticated with whatever ANTHROPIC_API_KEY
 * held — which for DeepSeek and OpenCode sessions is a third party's secret,
 * mirrored there by the provider wire.
 *
 * Every assertion below runs with NODE_ENV unset. isAnalyticsDisabled() short
 * circuits on NODE_ENV === 'test', so leaving it in place would make all of
 * these pass no matter what the production defaults are.
 */

const GENUINE_ANTHROPIC_KEY = 'sk-ant-genuine-user-key'
const DEEPSEEK_KEY = 'sk-deepseek-secret'

const CACHED_PAYLOAD: Record<string, unknown> = {
  // Stand-in for the 491 gates found on a real machine: one gate occ does not
  // pin (so the disk-cache branch is observable) and one it does.
  tengu_some_unpinned_gate: true,
  tengu_ultraplan_config: { enabled: false },
}

const ENV_KEYS = [
  'NODE_ENV',
  'CI',
  'DISABLE_TELEMETRY',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OCC_ENABLE_1P_TELEMETRY',
  'OCC_ENABLE_GROWTHBOOK',
  'CLAUDE_GB_ADAPTER_URL',
  'CLAUDE_GB_ADAPTER_KEY',
  'CLAUDE_CODE_DISABLE_LOCAL_GATES',
  'USER_TYPE',
  'OCC_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const

const savedEnv: Record<string, string | undefined> = {}

const configMock = setupConfigMock()
const userMock = setupUserMock()
const axiosHandle = setupAxiosMock()

/** Every POST/GET that reached the (mocked) network, in order. */
type RecordedRequest = { url: string; headers: Record<string, string> }
let requests: RecordedRequest[] = []
let fetchUrls: string[] = []

const realFetch = globalThis.fetch

function anthropicTraffic(): string[] {
  return [...requests.map(r => r.url), ...fetchUrls].filter(url =>
    url.includes('anthropic.com'),
  )
}

/** The DeepSeek shape: OPENAI_* configured, mirrored onto ANTHROPIC_*. */
function useDeepSeekMirror(opts: { ownAnthropicKey?: string } = {}): void {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  process.env.OPENAI_API_KEY = DEEPSEEK_KEY
  if (opts.ownAnthropicKey) {
    // Set BEFORE the mirror runs: the wire only ever claims keys it wrote, so
    // a user's own key survives and stays un-mirrored.
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
  // Rebuild the mirror's ledger against the now-empty env so it stops
  // vouching for this file's keys in every later file of the shard.
  applyDeepSeekAnthropicWire()
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]

  axiosHandle.stubs.post = (
    url: string,
    _data: unknown,
    config?: { headers?: Record<string, string> },
  ) => {
    requests.push({ url, headers: config?.headers ?? {} })
    return Promise.resolve({
      status: 200,
      data: {},
      headers: {},
      statusText: 'OK',
      config,
    })
  }
  axiosHandle.stubs.get = (
    url: string,
    config?: { headers?: Record<string, string> },
  ) => {
    requests.push({ url, headers: config?.headers ?? {} })
    return Promise.resolve({
      status: 200,
      data: {},
      headers: {},
      statusText: 'OK',
      config,
    })
  }
  axiosHandle.useStubs = true

  const recordingFetch = ((input: unknown) => {
    fetchUrls.push(String(input))
    return Promise.resolve(
      new Response(JSON.stringify({ features: {} }), { status: 200 }),
    )
  }) as typeof fetch
  globalThis.fetch = recordingFetch
  // The GrowthBook SDK binds globalThis.fetch at module load, so reassigning
  // the global after import does nothing. setPolyfills is the SDK's own seam.
  setPolyfills({ fetch: recordingFetch })

  configMock.set({
    getGlobalConfig: () =>
      ({
        cachedGrowthBookFeatures: CACHED_PAYLOAD,
        // Vouches for GENUINE_ANTHROPIC_KEY as a key occ configured, so the
        // auth chain resolves it without reaching the keychain.
        env: { ANTHROPIC_API_KEY: GENUINE_ANTHROPIC_KEY },
      }) as unknown as ReturnType<
        typeof import('src/utils/config/config.js').getGlobalConfig
      >,
    saveGlobalConfig: (() =>
      undefined) as unknown as typeof import('src/utils/config/config.js').saveGlobalConfig,
    getOrCreateUserID: () => 'device-under-test',
    checkHasTrustDialogAccepted: () => true,
  })
  userMock.set({
    // The real one calls getSubscriptionType()/getEmail(), which read the
    // OAuth token out of the system keychain.
    getCoreUserData: () =>
      ({
        deviceId: 'device-under-test',
        sessionId: 'session-under-test',
        platform: 'darwin',
      }) as unknown as ReturnType<
        typeof import('src/utils/auth/user.js').getCoreUserData
      >,
  })
})

afterAll(async () => {
  stopPeriodicGrowthBookRefresh()
  resetGrowthBook()
  await shutdown1PEventLogging()
  axiosHandle.useStubs = false
  globalThis.fetch = realFetch
  setPolyfills({ fetch: realFetch })
  await clearCache()
  configMock.reset()
  userMock.reset()
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  applyDeepSeekAnthropicWire()
})

beforeEach(async () => {
  requests = []
  fetchUrls = []
  stopPeriodicGrowthBookRefresh()
  resetGrowthBook()
  // The SDK keeps its own payload cache keyed by clientKey+attributes; without
  // this a later test would be served the earlier test's response with no fetch.
  await clearCache()
  for (const key of ENV_KEYS) delete process.env[key]
  clearProviderEnv()
  // Isolate the exporter's failed-event spool from the developer's real
  // ~/.occ/telemetry, whose leftovers would otherwise be POSTed on construction.
  process.env.OCC_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'occ-telemetry-'))
})

describe('default state: no first-party traffic', () => {
  test('nothing reaches api.anthropic.com with no opt-in configured', async () => {
    expect(is1PEventLoggingEnabled()).toBe(false)

    // Everything that can start first-party traffic, in one go.
    initialize1PEventLogging()
    logEventTo1P('occ_probe_event', { probe: true })
    logGrowthBookExperimentTo1P({ experimentId: 'exp_probe', variationId: 1 })
    await shutdown1PEventLogging()

    await expect(initializeGrowthBook()).resolves.toBeNull()
    await refreshGrowthBookFeatures()
    setupPeriodicGrowthBookRefresh()

    expect(anthropicTraffic()).toEqual([])
    expect(requests).toEqual([])
    expect(fetchUrls).toEqual([])
  })

  test('a stale on-disk GrowthBook payload no longer answers gates', () => {
    // The 491-gate cache is still on disk in this scenario. With the fetch
    // opted out, the readers never consult it — pinned or not.
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_some_unpinned_gate', false),
    ).toBe(false)
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE<{ enabled: boolean }>(
        'tengu_ultraplan_config',
        { enabled: true },
      ).enabled,
    ).toBe(true)
  })

  test('opting out of telemetry beats opting in to either sink', async () => {
    process.env.OCC_ENABLE_1P_TELEMETRY = '1'
    process.env.OCC_ENABLE_GROWTHBOOK = '1'
    process.env.DISABLE_TELEMETRY = '1'

    expect(is1PEventLoggingEnabled()).toBe(false)
    await expect(initializeGrowthBook()).resolves.toBeNull()
    expect(anthropicTraffic()).toEqual([])
  })

  test('the two switches are independent', async () => {
    process.env.OCC_ENABLE_GROWTHBOOK = '1'
    // Feature gates on, event export still off: turning on experiment
    // assignment must not start shipping usage events.
    expect(is1PEventLoggingEnabled()).toBe(false)

    initialize1PEventLogging()
    logGrowthBookExperimentTo1P({ experimentId: 'exp_probe', variationId: 1 })
    await shutdown1PEventLogging()
    expect(requests).toEqual([])
  })
})

describe('opt-in restores the behaviour', () => {
  test('OCC_ENABLE_GROWTHBOOK makes the fetch happen again', async () => {
    process.env.OCC_ENABLE_GROWTHBOOK = '1'
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    const client = await initializeGrowthBook()
    expect(client).not.toBeNull()
    expect(fetchUrls.some(url => url.includes('api.anthropic.com'))).toBe(true)
  })

  test('OCC_ENABLE_GROWTHBOOK makes the served/cached values live again', () => {
    process.env.OCC_ENABLE_GROWTHBOOK = '1'
    // Unpinned gate resolves from the payload, pinned gate still does not.
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_some_unpinned_gate', false),
    ).toBe(true)
    expect(
      getFeatureValue_CACHED_MAY_BE_STALE<{ enabled: boolean }>(
        'tengu_ultraplan_config',
        { enabled: true },
      ).enabled,
    ).toBe(true)
  })

  test('OCC_ENABLE_1P_TELEMETRY exports events again, with auth', async () => {
    process.env.OCC_ENABLE_1P_TELEMETRY = '1'
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })

    expect(is1PEventLoggingEnabled()).toBe(true)
    initialize1PEventLogging()
    logGrowthBookExperimentTo1P({ experimentId: 'exp_probe', variationId: 1 })
    await shutdown1PEventLogging()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(
      'https://api.anthropic.com/api/event_logging/batch',
    )
    // A key that really is the user's Anthropic key is still sent.
    expect(requests[0]!.headers['x-api-key']).toBe(GENUINE_ANTHROPIC_KEY)
  })
})

describe('mirrored third-party credentials never reach Anthropic', () => {
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
  })

  test('first-party auth refuses the mirrored key', () => {
    useDeepSeekMirror()
    const auth = getFirstPartyTelemetryAuthHeaders()
    expect(auth.error).toBeTruthy()
    expect(auth.headers['x-api-key']).toBeUndefined()
  })

  test('first-party auth passes a genuine Anthropic key through', () => {
    // Same session shape — DeepSeek configured — but ANTHROPIC_API_KEY holds
    // the user's own key, so the wire never claims it.
    useDeepSeekMirror({ ownAnthropicKey: GENUINE_ANTHROPIC_KEY })
    expect(isDeepSeekMirroredApiKey(GENUINE_ANTHROPIC_KEY)).toBe(false)
    expect(getFirstPartyTelemetryAuthHeaders().headers['x-api-key']).toBe(
      GENUINE_ANTHROPIC_KEY,
    )
  })

  test('an opted-in DeepSeek session exports without the mirrored key', async () => {
    process.env.OCC_ENABLE_1P_TELEMETRY = '1'
    useDeepSeekMirror()

    initialize1PEventLogging()
    logGrowthBookExperimentTo1P({ experimentId: 'exp_probe', variationId: 1 })
    await shutdown1PEventLogging()

    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(
      'https://api.anthropic.com/api/event_logging/batch',
    )
    expect(requests[0]!.headers['x-api-key']).toBeUndefined()
    expect(JSON.stringify(requests[0]!.headers)).not.toContain(DEEPSEEK_KEY)
  })

  test('an opted-in DeepSeek session does not authenticate the gate fetch', async () => {
    process.env.OCC_ENABLE_GROWTHBOOK = '1'
    useDeepSeekMirror()

    await initializeGrowthBook()
    // No usable first-party credential -> GrowthBook skips its HTTP init and
    // falls back to LOCAL_GATE_DEFAULTS rather than sending the DeepSeek key.
    expect(fetchUrls).toEqual([])
  })
})
