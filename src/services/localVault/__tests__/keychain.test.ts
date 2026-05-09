import { describe, test, expect, mock, beforeEach } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

// ── In-memory store backing the mock ─────────────────────────────────────────

const store: Record<string, string> = {}

// ── Class-based Entry mock ────────────────────────────────────────────────────

class MockEntry {
  constructor(
    public service: string,
    public account: string,
  ) {}

  getPassword(): string | null {
    return store[this.account] ?? null
  }

  setPassword(pw: string): void {
    store[this.account] = pw
  }

  deletePassword(): boolean {
    if (this.account in store) {
      delete store[this.account]
      return true
    }
    return false
  }
}

mock.module('@napi-rs/keyring', () => ({ Entry: MockEntry }))

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('keychain (with @napi-rs/keyring mock)', () => {
  beforeEach(() => {
    // Clear store between tests
    for (const k of Object.keys(store)) delete store[k]
    // Reset the module load cache so keychain re-imports the mocked module
    const keychainMod = require.cache?.['../keychain.js']
    if (keychainMod) delete require.cache['../keychain.js']
  })

  test('set and get round-trip', async () => {
    const { tryKeychain, _resetKeychainModuleCache } = await import(
      '../keychain.js'
    )
    _resetKeychainModuleCache()
    await tryKeychain.set('MY_KEY', 'my_secret_value')
    const result = await tryKeychain.get('MY_KEY')
    expect(result).toBe('my_secret_value')
  })

  test('get returns null for missing key', async () => {
    const { tryKeychain, _resetKeychainModuleCache } = await import(
      '../keychain.js'
    )
    _resetKeychainModuleCache()
    const result = await tryKeychain.get('NONEXISTENT_KEY')
    expect(result).toBeNull()
  })

  test('delete returns true for existing key', async () => {
    const { tryKeychain, _resetKeychainModuleCache } = await import(
      '../keychain.js'
    )
    _resetKeychainModuleCache()
    await tryKeychain.set('DELETE_ME', 'value')
    const result = await tryKeychain.delete('DELETE_ME')
    expect(result).toBe(true)
    expect(await tryKeychain.get('DELETE_ME')).toBeNull()
  })

  test('KeychainUnavailableError thrown when module exports invalid shape', async () => {
    // Temporarily replace with a bad module
    mock.module('@napi-rs/keyring', () => ({ Entry: null }))
    const { tryKeychain, KeychainUnavailableError, _resetKeychainModuleCache } =
      await import('../keychain.js')
    _resetKeychainModuleCache()
    await expect(tryKeychain.get('x')).rejects.toBeInstanceOf(
      KeychainUnavailableError,
    )
    // Restore
    mock.module('@napi-rs/keyring', () => ({ Entry: MockEntry }))
  })
})
