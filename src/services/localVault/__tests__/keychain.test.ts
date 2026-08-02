import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { PRODUCT_NAME } from 'src/constants/brand.js'
import { occConfigDir } from 'src/config/paths.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const LEGACY_SERVICE_NAME = 'claude-code-local-vault'
const store: Record<string, string> = {}
const entryCalls: Array<{ service: string; account: string }> = []

class MockEntry {
  constructor(
    public service: string,
    public account: string,
  ) {
    entryCalls.push({ service, account })
  }

  getPassword(): string | null {
    return store[`${this.service}\u0000${this.account}`] ?? null
  }

  setPassword(password: string): void {
    store[`${this.service}\u0000${this.account}`] = password
  }

  deletePassword(): boolean {
    const key = `${this.service}\u0000${this.account}`
    if (!(key in store)) return false
    delete store[key]
    return true
  }
}

mock.module('@napi-rs/keyring', () => ({ Entry: MockEntry }))

const {
  _resetKeychainModuleCache,
  getLocalVaultKeychainServiceName,
  tryKeychain,
} = await import('../keychain.js')

function expectedServiceName(): string {
  const profileHash = createHash('sha256')
    .update(occConfigDir())
    .digest('hex')
    .slice(0, 32)
  return `${PRODUCT_NAME}-local-vault-${profileHash}`
}

describe('local vault keychain isolation', () => {
  let savedOccConfigDir: string | undefined
  let savedLegacyConfigDir: string | undefined

  beforeEach(() => {
    savedOccConfigDir = process.env.OCC_CONFIG_DIR
    savedLegacyConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.OCC_CONFIG_DIR = '/tmp/occ-local-vault-test'
    delete process.env.CLAUDE_CONFIG_DIR
    occConfigDir.cache.clear?.()
    for (const key of Object.keys(store)) delete store[key]
    entryCalls.length = 0
    _resetKeychainModuleCache()
  })

  afterEach(() => {
    if (savedOccConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
    else process.env.OCC_CONFIG_DIR = savedOccConfigDir
    if (savedLegacyConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedLegacyConfigDir
    occConfigDir.cache.clear?.()
  })

  function expectOnlyOccService(): void {
    const expected = expectedServiceName()
    expect(entryCalls.length).toBeGreaterThan(0)
    expect(new Set(entryCalls.map(call => call.service))).toEqual(
      new Set([expected]),
    )
    expect(expected).not.toBe(LEGACY_SERVICE_NAME)
    expect(getLocalVaultKeychainServiceName()).toBe(expected)
  }

  test('writes and reads only the occ-owned service', async () => {
    await tryKeychain.set('MY_KEY', 'my_secret_value')
    expect(await tryKeychain.get('MY_KEY')).toBe('my_secret_value')
    expectOnlyOccService()
  })

  test('does not read a value from the inherited service', async () => {
    store[`${LEGACY_SERVICE_NAME}\u0000MY_KEY`] = 'inherited_secret'
    expect(await tryKeychain.get('MY_KEY')).toBeNull()
    expectOnlyOccService()
  })

  test('deletes only from the occ-owned service', async () => {
    const legacyKey = `${LEGACY_SERVICE_NAME}\u0000DELETE_ME`
    store[legacyKey] = 'inherited_secret'
    await tryKeychain.set('DELETE_ME', 'occ_secret')
    entryCalls.length = 0

    expect(await tryKeychain.delete('DELETE_ME')).toBe(true)
    expect(store[legacyKey]).toBe('inherited_secret')
    expectOnlyOccService()
  })

  test('index operations use only the occ-owned service', async () => {
    const legacyIndex = `${LEGACY_SERVICE_NAME}\u0000__index__`
    store[legacyIndex] = JSON.stringify(['INHERITED_KEY'])

    await tryKeychain._addToIndex('KEY_A')
    await tryKeychain._addToIndex('KEY_B')
    expect(await tryKeychain.list()).toEqual(['KEY_A', 'KEY_B'])
    await tryKeychain._removeFromIndex('KEY_A')
    expect(await tryKeychain.list()).toEqual(['KEY_B'])
    expect(store[legacyIndex]).toBe(JSON.stringify(['INHERITED_KEY']))
    expect(entryCalls.every(call => call.account === '__index__')).toBe(true)
    expectOnlyOccService()
  })

  test('isolates different OCC_CONFIG_DIR profiles', () => {
    const first = getLocalVaultKeychainServiceName()
    process.env.OCC_CONFIG_DIR = '/tmp/occ-local-vault-other-profile'
    occConfigDir.cache.clear?.()
    const second = getLocalVaultKeychainServiceName()
    expect(first).not.toBe(second)
    expect(first).toMatch(/[a-f0-9]{32}$/)
  })

  test('does not collide for profiles with the same former 32-bit digest', () => {
    process.env.OCC_CONFIG_DIR = '/tmp/occ-profile-55519'
    occConfigDir.cache.clear?.()
    const first = getLocalVaultKeychainServiceName()
    process.env.OCC_CONFIG_DIR = '/tmp/occ-profile-102538'
    occConfigDir.cache.clear?.()
    expect(getLocalVaultKeychainServiceName()).not.toBe(first)
  })

  test('rejects every malformed keychain index shape', async () => {
    const indexKey = `${expectedServiceName()}\u0000__index__`
    for (const invalid of ['null', '{}', '["VALID", 42]', 'not-json']) {
      store[indexKey] = invalid
      await expect(tryKeychain.list()).rejects.toThrow('index is corrupt')
    }
  })

  test('throws when the keyring module exports an invalid shape', async () => {
    mock.module('@napi-rs/keyring', () => ({ Entry: null }))
    _resetKeychainModuleCache()
    await expect(tryKeychain.get('x')).rejects.toThrow(
      'module does not export Entry',
    )
    mock.module('@napi-rs/keyring', () => ({ Entry: MockEntry }))
  })
})
