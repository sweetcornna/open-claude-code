import { describe, expect, test } from 'bun:test'
import {
  issuerScopedKey,
  issuersEquivalent,
  type McpOAuthStore,
  mcpOAuthKeysForServer,
  migrateMcpOAuthKeying,
  resolveMcpOAuthKey,
} from '../oauthCredentialKey.js'

const BASE = 'tenant-mcp|0123456789abcdef'
const OTHER_BASE = 'other-mcp|fedcba9876543210'
const ISSUER_A = 'https://tenant-a.idp.example.com'
const ISSUER_B = 'https://tenant-b.idp.example.com'

const KEY_A = issuerScopedKey(BASE, ISSUER_A)
const KEY_B = issuerScopedKey(BASE, ISSUER_B)

function tokens(overrides: Partial<McpOAuthStore[string]> = {}) {
  return {
    serverName: 'tenant-mcp',
    serverUrl: 'https://tenant.example.com/mcp',
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    expiresAt: 1_000,
    ...overrides,
  }
}

describe('issuersEquivalent', () => {
  test('tolerates exactly one trailing slash, mirroring the SDK', () => {
    // The SDK spells the issuer `metadata.issuer` when it has metadata and
    // `String(new URL(...))` — always slash-suffixed — when it does not.
    expect(issuersEquivalent(ISSUER_A, `${ISSUER_A}/`)).toBe(true)
    expect(issuersEquivalent(`${ISSUER_A}/`, ISSUER_A)).toBe(true)
    expect(issuersEquivalent(ISSUER_A, ISSUER_A)).toBe(true)
  })

  test('does not tolerate anything else', () => {
    expect(issuersEquivalent(ISSUER_A, ISSUER_B)).toBe(false)
    expect(issuersEquivalent(ISSUER_A, `${ISSUER_A}//`)).toBe(false)
    expect(issuersEquivalent(ISSUER_A, ISSUER_A.toUpperCase())).toBe(false)
    expect(issuersEquivalent(ISSUER_A, `${ISSUER_A}/tenant`)).toBe(false)
  })

  test('drives the slot, so both spellings share credentials', () => {
    expect(issuerScopedKey(BASE, `${ISSUER_A}/`)).toBe(KEY_A)
  })
})

describe('issuerScopedKey', () => {
  test('extends the base key and is stable for one issuer', () => {
    expect(KEY_A.startsWith(`${BASE}|iss:`)).toBe(true)
    expect(issuerScopedKey(BASE, ISSUER_A)).toBe(KEY_A)
  })

  test('separates issuers that share a server config', () => {
    expect(KEY_A).not.toBe(KEY_B)
  })

  test('appends a bounded suffix so the credential blob cannot grow with issuer length', () => {
    const long = `https://${'x'.repeat(2000)}.example.com`
    expect(issuerScopedKey(BASE, long).length - BASE.length).toBe(
      KEY_A.length - BASE.length,
    )
  })
})

describe('mcpOAuthKeysForServer', () => {
  test('collects the base key and every issuer-scoped key for one server', () => {
    const store: McpOAuthStore = {
      [BASE]: tokens(),
      [KEY_A]: tokens(),
      [KEY_B]: tokens(),
      [OTHER_BASE]: tokens(),
      [issuerScopedKey(OTHER_BASE, ISSUER_A)]: tokens(),
    }
    expect(new Set(mcpOAuthKeysForServer(store, BASE))).toEqual(
      new Set([BASE, KEY_A, KEY_B]),
    )
  })

  test('is empty for an absent store', () => {
    expect(mcpOAuthKeysForServer(undefined, BASE)).toEqual([])
  })
})

describe('resolveMcpOAuthKey', () => {
  test('is exact when the issuer is known', () => {
    expect(resolveMcpOAuthKey({}, BASE, ISSUER_A)).toBe(KEY_A)
    expect(resolveMcpOAuthKey({ [BASE]: tokens() }, BASE, ISSUER_A)).toBe(KEY_A)
  })

  test('falls back to the base key when nothing is stored yet', () => {
    expect(resolveMcpOAuthKey(undefined, BASE, undefined)).toBe(BASE)
    expect(resolveMcpOAuthKey({}, BASE, undefined)).toBe(BASE)
  })

  test('adopts the single issuer-scoped slot at session start', () => {
    // Without this a restart would read the empty base key and look like
    // "never authenticated", forcing a needless re-auth.
    expect(resolveMcpOAuthKey({ [KEY_A]: tokens() }, BASE, undefined)).toBe(
      KEY_A,
    )
  })

  test('ignores slots belonging to a different server config', () => {
    const store: McpOAuthStore = {
      [issuerScopedKey(OTHER_BASE, ISSUER_A)]: tokens(),
    }
    expect(resolveMcpOAuthKey(store, BASE, undefined)).toBe(BASE)
  })

  test('prefers the longest-lived slot when the issuer changed over time', () => {
    const store: McpOAuthStore = {
      [KEY_A]: tokens({ expiresAt: 1_000 }),
      [KEY_B]: tokens({ expiresAt: 9_000 }),
    }
    expect(resolveMcpOAuthKey(store, BASE, undefined)).toBe(KEY_B)
  })

  test('breaks expiry ties deterministically so concurrent processes agree', () => {
    const store: McpOAuthStore = {
      [KEY_A]: tokens({ expiresAt: 5_000 }),
      [KEY_B]: tokens({ expiresAt: 5_000 }),
    }
    const expected = KEY_A < KEY_B ? KEY_A : KEY_B
    expect(resolveMcpOAuthKey(store, BASE, undefined)).toBe(expected)
    expect(
      resolveMcpOAuthKey(
        { [KEY_B]: store[KEY_B] as never, [KEY_A]: store[KEY_A] as never },
        BASE,
        undefined,
      ),
    ).toBe(expected)
  })
})

describe('migrateMcpOAuthKeying', () => {
  test('does nothing when there is no legacy entry', () => {
    const store: McpOAuthStore = { [KEY_A]: tokens() }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(false)
    expect(store).toEqual({ [KEY_A]: tokens() })
  })

  test('moves an unattributed legacy entry without losing its tokens', () => {
    // The upgrade path: everything written before issuer keying is
    // unattributed, and refusing to claim it would sign every user out.
    const store: McpOAuthStore = {
      [BASE]: tokens({ accessToken: 'legacy-access', clientId: 'client-1' }),
    }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(true)
    expect(store[BASE]).toBeUndefined()
    expect(store[KEY_A]).toEqual(
      tokens({
        accessToken: 'legacy-access',
        clientId: 'client-1',
        issuer: ISSUER_A,
      }),
    )
  })

  test('moves an entry that already names this issuer', () => {
    const store: McpOAuthStore = { [BASE]: tokens({ issuer: ISSUER_A }) }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(true)
    expect(store[KEY_A]).toEqual(tokens({ issuer: ISSUER_A }))
    expect(store[BASE]).toBeUndefined()
  })

  test('re-homes an entry that names a different issuer instead of claiming it', () => {
    // The multi-tenant collision: tokens minted by tenant A must never end up
    // in tenant B's slot, but they must not be thrown away either.
    const store: McpOAuthStore = {
      [BASE]: tokens({ issuer: ISSUER_A, accessToken: 'tenant-a-token' }),
    }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_B)).toBe(true)
    expect(store[BASE]).toBeUndefined()
    expect(store[KEY_B]).toBeUndefined()
    expect(store[KEY_A]?.accessToken).toBe('tenant-a-token')
  })

  test('drops a foreign legacy entry whose own slot is already populated', () => {
    const store: McpOAuthStore = {
      [BASE]: tokens({ issuer: ISSUER_A, accessToken: 'stale' }),
      [KEY_A]: tokens({ issuer: ISSUER_A, accessToken: 'current' }),
    }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_B)).toBe(true)
    expect(store[BASE]).toBeUndefined()
    expect(store[KEY_A]?.accessToken).toBe('current')
  })

  test('drops a superseded legacy entry rather than merging it', () => {
    // The blob has a hard 4096-byte ceiling on macOS (#30337), so superseded
    // state has to go rather than accumulate.
    const store: McpOAuthStore = {
      [BASE]: tokens({ accessToken: 'stale' }),
      [KEY_A]: tokens({ accessToken: 'current', issuer: ISSUER_A }),
    }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(true)
    expect(store[BASE]).toBeUndefined()
    expect(store[KEY_A]?.accessToken).toBe('current')
  })

  test('is idempotent', () => {
    const store: McpOAuthStore = { [BASE]: tokens() }
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(true)
    const afterFirst = structuredClone(store)
    expect(migrateMcpOAuthKeying(store, BASE, ISSUER_A)).toBe(false)
    expect(store).toEqual(afterFirst)
  })

  test('leaves other servers alone', () => {
    const store: McpOAuthStore = {
      [BASE]: tokens(),
      [OTHER_BASE]: tokens({ accessToken: 'other-server' }),
    }
    migrateMcpOAuthKeying(store, BASE, ISSUER_A)
    expect(store[OTHER_BASE]?.accessToken).toBe('other-server')
  })

  test('resolves to the migrated slot afterwards, with and without the issuer', () => {
    const store: McpOAuthStore = { [BASE]: tokens() }
    migrateMcpOAuthKeying(store, BASE, ISSUER_A)
    expect(resolveMcpOAuthKey(store, BASE, ISSUER_A)).toBe(KEY_A)
    expect(resolveMcpOAuthKey(store, BASE, undefined)).toBe(KEY_A)
  })
})
