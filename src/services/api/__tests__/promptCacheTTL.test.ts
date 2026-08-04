import { describe, expect, test } from 'bun:test'
import {
  PROMPT_CACHE_1H_DEFAULT_ALLOWLIST,
  matches1hCacheAllowlist,
  resolve1hCacheAllowlist,
} from '../promptCacheTTL.js'

describe('resolve1hCacheAllowlist', () => {
  test('falls back to the defaults when GrowthBook serves no config', () => {
    // Regression: this used to resolve to [], so should1hCacheTTL() could
    // never return true and every session ran on the 5-minute TTL — a full
    // prefix rewrite after any pause longer than 5 minutes.
    expect(resolve1hCacheAllowlist({})).toEqual(
      PROMPT_CACHE_1H_DEFAULT_ALLOWLIST,
    )
  })

  test('an explicitly empty allowlist still disables 1h TTL', () => {
    // The remote kill switch has to keep working.
    expect(resolve1hCacheAllowlist({ allowlist: [] })).toEqual([])
  })

  test('a served allowlist wins over the defaults', () => {
    expect(resolve1hCacheAllowlist({ allowlist: ['sdk'] })).toEqual(['sdk'])
  })
})

describe('matches1hCacheAllowlist', () => {
  test('the default allowlist covers the long-lived sources', () => {
    for (const source of [
      'repl_main_thread',
      'repl_main_thread_fallback',
      'compact',
      'sdk',
      'agent:custom',
      'agent:default',
    ]) {
      expect(
        matches1hCacheAllowlist(source, PROMPT_CACHE_1H_DEFAULT_ALLOWLIST),
      ).toBe(true)
    }
  })

  test('short-lived forked sources stay on the 5m TTL', () => {
    // A 1h write for a 1-3 turn fork is paid for and never read back.
    for (const source of [
      'speculation',
      'session_memory',
      'prompt_suggestion',
      'auto_mode',
    ]) {
      expect(
        matches1hCacheAllowlist(source, PROMPT_CACHE_1H_DEFAULT_ALLOWLIST),
      ).toBe(false)
    }
  })

  test('trailing star is a prefix match, bare patterns are exact', () => {
    expect(matches1hCacheAllowlist('agent:custom', ['agent:*'])).toBe(true)
    expect(matches1hCacheAllowlist('sdk_extra', ['sdk'])).toBe(false)
    expect(matches1hCacheAllowlist('anything', ['*'])).toBe(true)
  })

  test('an undefined query source never matches', () => {
    expect(
      matches1hCacheAllowlist(undefined, PROMPT_CACHE_1H_DEFAULT_ALLOWLIST),
    ).toBe(false)
    expect(matches1hCacheAllowlist(undefined, ['*'])).toBe(false)
  })
})
