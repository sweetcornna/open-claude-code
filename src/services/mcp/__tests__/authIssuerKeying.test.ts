/**
 * Wiring tests for issuer-keyed credential storage.
 *
 * `oauthCredentialKey.test.ts` covers the keying and migration rules
 * themselves; this file proves `ClaudeAuthProvider` actually reaches them —
 * that an issuer learned from any of the hooks re-homes a pre-upgrade entry
 * without losing the user's tokens, and that two issuers behind one server
 * config no longer share a slot.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import { setupSecureStorageMock } from '../../../../tests/mocks/secureStorage'

const secureStorage = setupSecureStorageMock()

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/secureStorage/index.ts', secureStorage.mock)

const SERVER_NAME = 'tenant-mcp'
const SERVER_CONFIG = {
  type: 'http',
  url: 'https://tenant.example.com/mcp',
} as const

const ISSUER_A = 'https://tenant-a.idp.example.com'
const ISSUER_B = 'https://tenant-b.idp.example.com'

// Imported dynamically so the mocks above are registered first, and at module
// scope rather than inside a test so `auth.ts`'s (large) import graph is not
// charged to the first test's timeout.
const {
  ClaudeAuthProvider,
  clearServerTokensFromLocalStorage,
  getMcpClientConfig,
  getServerKey,
  hasMcpDiscoveryButNoToken,
  saveMcpClientSecret,
} = await import('../auth.js')
const { issuerScopedKey } = await import('../oauthCredentialKey.js')

const LEGACY_ENTRY = {
  serverName: SERVER_NAME,
  serverUrl: SERVER_CONFIG.url,
  accessToken: 'legacy-access-token',
  refreshToken: 'legacy-refresh-token',
  expiresAt: Date.now() + 3_600_000,
  clientId: 'legacy-client-id',
  clientSecret: 'legacy-client-secret',
}

function keys() {
  const base = getServerKey(SERVER_NAME, SERVER_CONFIG)
  return {
    base,
    a: issuerScopedKey(base, ISSUER_A),
    b: issuerScopedKey(base, ISSUER_B),
  }
}

function newProvider() {
  return new ClaudeAuthProvider(SERVER_NAME, SERVER_CONFIG)
}

function storedOAuth(): Record<string, Record<string, unknown>> {
  return (secureStorage.snapshot()?.mcpOAuth ?? {}) as Record<
    string,
    Record<string, unknown>
  >
}

describe('ClaudeAuthProvider issuer keying', () => {
  beforeEach(() => {
    secureStorage.reset()
  })

  test('reads pre-upgrade credentials before any issuer is known', async () => {
    const { base } = keys()
    secureStorage.seed({ mcpOAuth: { [base]: LEGACY_ENTRY } })

    const provider = newProvider()
    expect((await provider.tokens())?.access_token).toBe('legacy-access-token')
    expect((await provider.clientInformation())?.client_id).toBe(
      'legacy-client-id',
    )
  })

  test('re-homes them under the issuer without losing anything', async () => {
    const { base, a } = keys()
    secureStorage.seed({ mcpOAuth: { [base]: LEGACY_ENTRY } })

    const provider = newProvider()
    await provider.saveAuthorizationServerUrl(ISSUER_A)

    const stored = storedOAuth()
    expect(stored[base]).toBeUndefined()
    expect(stored[a]).toMatchObject({
      accessToken: 'legacy-access-token',
      refreshToken: 'legacy-refresh-token',
      clientId: 'legacy-client-id',
      issuer: ISSUER_A,
    })
    expect((await provider.tokens())?.access_token).toBe('legacy-access-token')
  })

  test('learns the issuer from the SEP-2352 call context too', async () => {
    const { base, a } = keys()
    secureStorage.seed({ mcpOAuth: { [base]: LEGACY_ENTRY } })

    const provider = newProvider()
    const tokens = await provider.tokens({ issuer: ISSUER_A })

    expect(tokens?.access_token).toBe('legacy-access-token')
    // Round-tripped so the SDK's own issuer binding check has something to
    // compare against instead of warning about an unattributed credential.
    expect(tokens?.issuer).toBe(ISSUER_A)
    expect(storedOAuth()[a]).toBeDefined()
  })

  test('learns it from discovery metadata on the v1 flow, which has no context', async () => {
    const { base, a } = keys()
    secureStorage.seed({ mcpOAuth: { [base]: LEGACY_ENTRY } })

    const provider = newProvider()
    await provider.saveDiscoveryState({
      authorizationServerUrl: `${ISSUER_A}/`,
      authorizationServerMetadata: {
        issuer: ISSUER_A,
      } as never,
    })

    const stored = storedOAuth()
    expect(stored[base]).toBeUndefined()
    expect(stored[a]).toBeDefined()
  })

  test('tolerates a trailing slash rather than splitting the slot', async () => {
    // The SDK derives the issuer from `metadata.issuer` when it has metadata
    // and from a slash-suffixed URL string when it does not; both must land on
    // the same credentials.
    const { a } = keys()

    const withSlash = newProvider()
    await withSlash.saveAuthorizationServerUrl(`${ISSUER_A}/`)
    await withSlash.saveTokens({
      access_token: 'slashed',
      token_type: 'Bearer',
      expires_in: 3600,
    })

    expect(storedOAuth()[a]).toBeDefined()

    const withoutSlash = newProvider()
    await withoutSlash.saveAuthorizationServerUrl(ISSUER_A)
    expect((await withoutSlash.tokens())?.access_token).toBe('slashed')
  })

  test('keeps two issuers behind one server config apart', async () => {
    const { a, b } = keys()

    const first = newProvider()
    await first.saveAuthorizationServerUrl(ISSUER_A)
    await first.saveTokens({
      access_token: 'tenant-a-token',
      token_type: 'Bearer',
      expires_in: 3600,
    })

    const second = newProvider()
    await second.saveAuthorizationServerUrl(ISSUER_B)
    await second.saveTokens({
      access_token: 'tenant-b-token',
      token_type: 'Bearer',
      expires_in: 3600,
    })

    const stored = storedOAuth()
    expect(stored[a]?.accessToken).toBe('tenant-a-token')
    expect(stored[b]?.accessToken).toBe('tenant-b-token')

    // And each provider still sees only its own issuer's token.
    expect((await first.tokens())?.access_token).toBe('tenant-a-token')
    expect((await second.tokens())?.access_token).toBe('tenant-b-token')
  })

  test("does not hand one issuer the other issuer's pre-upgrade tokens", async () => {
    const { base, a, b } = keys()
    secureStorage.seed({
      mcpOAuth: { [base]: { ...LEGACY_ENTRY, issuer: ISSUER_A } },
    })

    const provider = newProvider()
    await provider.saveAuthorizationServerUrl(ISSUER_B)

    const stored = storedOAuth()
    expect(stored[b]).toBeUndefined()
    expect(stored[a]?.accessToken).toBe('legacy-access-token')
    expect(await provider.tokens()).toBeUndefined()
  })

  test('clearing auth removes every issuer slot for the server', async () => {
    const { base, a, b } = keys()
    secureStorage.seed({
      mcpOAuth: {
        [base]: LEGACY_ENTRY,
        [a]: { ...LEGACY_ENTRY, issuer: ISSUER_A },
        [b]: { ...LEGACY_ENTRY, issuer: ISSUER_B },
        'other-server|deadbeefdeadbeef': LEGACY_ENTRY,
      },
    })

    clearServerTokensFromLocalStorage(SERVER_NAME, SERVER_CONFIG)

    const stored = storedOAuth()
    expect(Object.keys(stored)).toEqual(['other-server|deadbeefdeadbeef'])
  })

  test('reports "authenticated once, no token now" against the issuer slot', async () => {
    const { a } = keys()
    expect(hasMcpDiscoveryButNoToken(SERVER_NAME, SERVER_CONFIG)).toBe(false)

    secureStorage.seed({
      mcpOAuth: {
        [a]: {
          serverName: SERVER_NAME,
          serverUrl: SERVER_CONFIG.url,
          accessToken: '',
          expiresAt: 0,
          issuer: ISSUER_A,
        },
      },
    })
    expect(hasMcpDiscoveryButNoToken(SERVER_NAME, SERVER_CONFIG)).toBe(true)
  })

  test('leaves the user-configured client secret on the config key', async () => {
    // `mcp add --client-secret` runs long before any issuer exists, so that
    // slot must stay keyed by the server config alone.
    const { base } = keys()
    saveMcpClientSecret(SERVER_NAME, SERVER_CONFIG, 'configured-secret')
    expect(
      (
        secureStorage.snapshot()?.mcpOAuthClientConfig as Record<
          string,
          unknown
        >
      )[base],
    ).toEqual({ clientSecret: 'configured-secret' })

    const provider = newProvider()
    await provider.saveAuthorizationServerUrl(ISSUER_A)
    expect(getMcpClientConfig(SERVER_NAME, SERVER_CONFIG)?.clientSecret).toBe(
      'configured-secret',
    )
  })

  test('migrates once, not on every hook', async () => {
    const { base } = keys()
    secureStorage.seed({ mcpOAuth: { [base]: LEGACY_ENTRY } })

    const provider = newProvider()
    await provider.saveAuthorizationServerUrl(ISSUER_A)
    const writesAfterMigration = secureStorage.writes()

    await provider.saveAuthorizationServerUrl(ISSUER_A)
    await provider.tokens({ issuer: ISSUER_A })
    await provider.clientInformation({ issuer: ISSUER_A })

    expect(secureStorage.writes()).toBe(writesAfterMigration)
  })
})
