import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
} from '../macOsKeychainHelpers.js'
import {
  getLegacyClaudeKeychainServiceNames,
  LEGACY_CREDENTIALS_SERVICE_SUFFIX,
} from '../legacyClaudeKeychain.js'

// No `security` is spawned here: only the name derivation is pure enough to
// pin, and it is the part that decides whether the migration finds anything at
// all. The read path is exercised through migrateCredentials' injected reader.

const LEGACY = 'CLAUDE_CONFIG_DIR'
let saved: string | undefined

beforeEach(() => {
  saved = process.env[LEGACY]
  delete process.env[LEGACY]
  occConfigDir.cache.clear?.()
})

afterEach(() => {
  delete process.env[LEGACY]
  if (saved !== undefined) process.env[LEGACY] = saved
  occConfigDir.cache.clear?.()
})

describe('getLegacyClaudeKeychainServiceNames', () => {
  test('a default install has exactly one candidate: the unhashed name', () => {
    // The official CLI appends a config-dir hash ONLY when CLAUDE_CONFIG_DIR is
    // set. An earlier version of this function always emitted a second,
    // `sha256(~/.claude)`-hashed candidate — which is exactly the case where
    // the official CLI appends nothing, so it could never match anything. A
    // probe that cannot hit is worse than no probe: it reads as coverage.
    expect(
      getLegacyClaudeKeychainServiceNames(LEGACY_CREDENTIALS_SERVICE_SUFFIX),
    ).toEqual(['Claude Code-credentials'])
  })

  test('adds the hashed variant only when CLAUDE_CONFIG_DIR is set, hashing that value', () => {
    process.env[LEGACY] = '/tmp/official-claude-dir'
    const hash = createHash('sha256')
      .update(resolve('/tmp/official-claude-dir'))
      .digest('hex')
      .substring(0, 8)
    expect(
      getLegacyClaudeKeychainServiceNames(LEGACY_CREDENTIALS_SERVICE_SUFFIX),
    ).toEqual(['Claude Code-credentials', `Claude Code-credentials-${hash}`])
  })

  test('names the legacy API-key entry without a suffix', () => {
    expect(getLegacyClaudeKeychainServiceNames()).toEqual(['Claude Code'])
  })

  test('never names one of occ’s own entries, even when both read the same env', () => {
    // The point of the whole isolation effort: reading the official entries
    // must not be able to alias onto occ's, or a migration would read back what
    // it just wrote. CLAUDE_CONFIG_DIR is the sharpest case — occ honours it as
    // a deprecated fallback for its OWN root, so both sides hash the same
    // string and only the service prefix keeps them apart.
    process.env[LEGACY] = '/tmp/shared-config-dir'
    occConfigDir.cache.clear?.()
    const occName = getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    )
    const legacyNames = [
      ...getLegacyClaudeKeychainServiceNames(LEGACY_CREDENTIALS_SERVICE_SUFFIX),
      ...getLegacyClaudeKeychainServiceNames(),
    ]
    expect(legacyNames).not.toContain(occName)
    expect(legacyNames.every(n => !n.startsWith('Open Claude Code'))).toBe(true)
  })
})
