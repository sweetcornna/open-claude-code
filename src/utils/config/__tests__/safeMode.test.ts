/**
 * `--safe-mode` / CLAUDE_CODE_SAFE_MODE.
 *
 * No module mocks: every predicate under test short-circuits on the env var or
 * argv before it touches settings, the filesystem or GrowthBook, so the real
 * modules answer correctly on their own. The one case that does read settings
 * (`isRestrictedToPluginOnly` with safe mode off) resolves to "no policy set"
 * against the test config dir, which is exactly the baseline being asserted.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { isSafeMode, safeModeExitHint } from '../envUtils.js'
import { shouldAllowManagedHooksOnly } from '../../hooks/hooksConfigSnapshot.js'
import { isRestrictedToPluginOnly } from '../../settings/pluginOnlyPolicy.js'

const originalArgv = process.argv

function restoreEnv(): void {
  delete process.env.CLAUDE_CODE_SAFE_MODE
  process.argv = originalArgv
}

afterEach(restoreEnv)

describe('isSafeMode', () => {
  test('is off by default', () => {
    expect(isSafeMode()).toBe(false)
  })

  test('CLAUDE_CODE_SAFE_MODE=1 turns it on', () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    expect(isSafeMode()).toBe(true)
  })

  test('accepts the other truthy spellings', () => {
    for (const value of ['true', 'yes', 'on']) {
      process.env.CLAUDE_CODE_SAFE_MODE = value
      expect(isSafeMode()).toBe(true)
    }
  })

  test('CLAUDE_CODE_SAFE_MODE=0 leaves it off', () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '0'
    expect(isSafeMode()).toBe(false)
  })

  test('--safe-mode in argv turns it on before the env var is set', () => {
    process.argv = [...originalArgv, '--safe-mode']
    expect(isSafeMode()).toBe(true)
  })
})

describe('safeModeExitHint', () => {
  test('tells flag users to restart', () => {
    process.argv = [...originalArgv, '--safe-mode']
    expect(safeModeExitHint()).toBe('restart without --safe-mode')
  })

  test('tells env-var users to unset it', () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    expect(safeModeExitHint()).toBe('unset CLAUDE_CODE_SAFE_MODE')
  })
})

describe('customization surfaces under safe mode', () => {
  test('every surface is locked, so only managed sources load', () => {
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    for (const surface of ['skills', 'agents', 'hooks', 'mcp'] as const) {
      expect(isRestrictedToPluginOnly(surface)).toBe(true)
    }
  })

  test('no surface is locked without safe mode or the managed policy', () => {
    for (const surface of ['skills', 'agents', 'hooks', 'mcp'] as const) {
      expect(isRestrictedToPluginOnly(surface)).toBe(false)
    }
  })

  test('hooks, statusLine and fileSuggestion fall back to managed-only', () => {
    expect(shouldAllowManagedHooksOnly()).toBe(false)
    process.env.CLAUDE_CODE_SAFE_MODE = '1'
    expect(shouldAllowManagedHooksOnly()).toBe(true)
  })
})
