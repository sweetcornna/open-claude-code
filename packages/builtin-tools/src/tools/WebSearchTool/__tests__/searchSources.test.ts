import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import {
  registerSearchCredentialProbe,
  resetSearchCredentialProbe,
  type SearchCredentialFamily,
} from '@open-claude-code/tool-runtime/searchCredentials.js'
import * as realSettings from 'src/utils/settings/settings.js'
import { makeSharedModuleMock } from '../../../../../../tests/mocks/sharedModuleMock'

// Captured before the mock patches the live namespace (see adapterFactory.test).
const realGetSettings = realSettings.getSettings_DEPRECATED

const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup()

const {
  isSourceActive,
  isSourceAvailable,
  isSourceEnabled,
  isUnsupportedSourceError,
  markSourceUnavailable,
  resetSourceAvailability,
  withSourceHealth,
} = await import('../adapters/searchSources')

function withCredentials(families: SearchCredentialFamily[]): void {
  const owned = new Set(families)
  registerSearchCredentialProbe(family => owned.has(family))
}

function withSourceSettings(sources?: Record<string, boolean>): void {
  settingsMock.set({
    getSettings_DEPRECATED: () =>
      ({
        ...realGetSettings(),
        webSearchSources: sources,
      }) as ReturnType<typeof realGetSettings>,
  })
}

beforeEach(() => {
  resetSourceAvailability()
  withCredentials([])
  withSourceSettings(undefined)
})

afterEach(() => {
  resetSourceAvailability()
})

afterAll(() => {
  settingsMock.reset()
  resetSearchCredentialProbe()
})

describe('isSourceEnabled', () => {
  test('credentials switch a provider source on with no configuration', () => {
    withCredentials(['anthropic', 'codex'])

    expect(isSourceEnabled('anthropic')).toBe(true)
    expect(isSourceEnabled('codex')).toBe(true)
    expect(isSourceEnabled('gemini')).toBe(false)
  })

  test('free needs no account', () => {
    expect(isSourceEnabled('free')).toBe(true)
  })

  test('an explicit "off" wins over held credentials', () => {
    withCredentials(['anthropic'])
    withSourceSettings({ anthropic: false })

    expect(isSourceEnabled('anthropic')).toBe(false)
  })

  test('an explicit "on" cannot manufacture missing credentials', () => {
    // Ticking a source records "use it when it works", not "fire a lane at a
    // backend that cannot serve the search". Forcing one on produced a primary
    // lane that returned zero results with no error — worse than an absent
    // source, because the model reads the empty list as "the web has no
    // answer". The fix is to acquire the capability, not to insist on the flag.
    withCredentials([])
    withSourceSettings({ gemini: true })

    expect(isSourceEnabled('gemini')).toBe(false)
  })

  test('an explicit "on" is a no-op when the credentials are there anyway', () => {
    withCredentials(['gemini'])
    withSourceSettings({ gemini: true })

    expect(isSourceEnabled('gemini')).toBe(true)
  })

  test('a malformed webSearchSources block reads as "no explicit choices"', () => {
    withCredentials(['anthropic'])
    settingsMock.set({
      getSettings_DEPRECATED: () =>
        ({
          ...realGetSettings(),
          webSearchSources: 'nonsense',
        }) as unknown as ReturnType<typeof realGetSettings>,
    })

    expect(isSourceEnabled('anthropic')).toBe(true)
    expect(isSourceEnabled('free')).toBe(true)
  })
})

describe('source availability', () => {
  test('marking a source unavailable takes it out of the aggregation', () => {
    withCredentials(['codex'])
    expect(isSourceActive('codex')).toBe(true)

    markSourceUnavailable('codex')

    expect(isSourceAvailable('codex')).toBe(false)
    expect(isSourceEnabled('codex')).toBe(true)
    expect(isSourceActive('codex')).toBe(false)
  })

  test('resetting re-probes after a fresh login', () => {
    markSourceUnavailable('gemini')
    resetSourceAvailability()

    expect(isSourceAvailable('gemini')).toBe(true)
  })
})

describe('isUnsupportedSourceError', () => {
  test('recognises capability failures', () => {
    for (const message of [
      'Responses API request failed (400): Unsupported tool: web_search',
      'This project does not support web_search',
      'web_search is not available for this account',
      '403 Forbidden: web_search grounding is disabled',
    ]) {
      expect(isUnsupportedSourceError(new Error(message))).toBe(true)
    }
  })

  test('leaves transient failures alone', () => {
    for (const message of [
      'fetch failed',
      'Responses API request failed (429): rate limit exceeded',
      'socket hang up',
    ]) {
      expect(isUnsupportedSourceError(new Error(message))).toBe(false)
    }
  })
})

describe('withSourceHealth', () => {
  test('retires the source on a capability failure and re-throws', async () => {
    const lane = withSourceHealth('codex', {
      async search() {
        throw new Error('Unsupported tool: web_search')
      },
    })

    await expect(lane.search('q', {})).rejects.toThrow(/web_search/)
    expect(isSourceAvailable('codex')).toBe(false)
  })

  test('leaves the source available after a transient failure', async () => {
    const lane = withSourceHealth('codex', {
      async search() {
        throw new Error('fetch failed')
      },
    })

    await expect(lane.search('q', {})).rejects.toThrow('fetch failed')
    expect(isSourceAvailable('codex')).toBe(true)
  })

  test('passes results through untouched', async () => {
    const hits = [{ title: 'x', url: 'https://x.example' }]
    const lane = withSourceHealth('free', {
      async search() {
        return hits
      },
    })

    expect(await lane.search('q', {})).toBe(hits)
  })
})
