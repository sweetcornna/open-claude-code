import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { occConfigDir } from 'src/config/paths.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
} from '../macOsKeychainHelpers.js'

const OCC = 'OCC_CONFIG_DIR'
const LEGACY = 'CLAUDE_CONFIG_DIR'

let savedOcc: string | undefined
let savedLegacy: string | undefined

function reset(): void {
  delete process.env[OCC]
  delete process.env[LEGACY]
  occConfigDir.cache.clear?.()
}

beforeEach(() => {
  savedOcc = process.env[OCC]
  savedLegacy = process.env[LEGACY]
  reset()
})

afterEach(() => {
  reset()
  if (savedOcc !== undefined) process.env[OCC] = savedOcc
  if (savedLegacy !== undefined) process.env[LEGACY] = savedLegacy
  occConfigDir.cache.clear?.()
})

describe('getMacOsKeychainStorageServiceName', () => {
  test('never collides with the official Claude Code credential entry', () => {
    // Regression guard for the isolation bug this replaced: the old
    // implementation appended the config-dir hash ONLY when CLAUDE_CONFIG_DIR
    // was set, so a default install produced exactly "Claude Code-credentials"
    // — the same entry the official CLI uses. Signing in to either CLI
    // overwrote the other's OAuth token.
    const name = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    expect(name).not.toBe('Claude Code-credentials')
    expect(name.startsWith('Claude Code')).toBe(false)
    expect(name.startsWith('Open Claude Code')).toBe(true)
  })

  test('appends a config-dir hash even for the default config dir', () => {
    const name = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    expect(name).toMatch(/-[0-9a-f]{8}$/)
  })

  test('gives two different config dirs two different service names', () => {
    process.env[OCC] = '/tmp/occ-a'
    occConfigDir.cache.clear?.()
    const a = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)

    process.env[OCC] = '/tmp/occ-b'
    occConfigDir.cache.clear?.()
    const b = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)

    expect(a).not.toBe(b)
  })

  test('is stable for the same config dir across calls', () => {
    process.env[OCC] = '/tmp/occ-stable'
    occConfigDir.cache.clear?.()
    const first = getMacOsKeychainStorageServiceName(CREDENTIALS_SERVICE_SUFFIX)
    occConfigDir.cache.clear?.()
    const second = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    expect(first).toBe(second)
  })

  test('keeps the credentials entry distinct from the legacy API-key entry', () => {
    const credentials = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const apiKey = getMacOsKeychainStorageServiceName()
    expect(credentials).not.toBe(apiKey)
    expect(credentials).toContain(CREDENTIALS_SERVICE_SUFFIX)
  })
})
