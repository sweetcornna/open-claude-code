import {
  afterAll,
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  mock,
} from 'bun:test'
import * as path from 'node:path'
import * as os from 'node:os'
import * as fsp from 'node:fs/promises'
import { setupEnvUtilsMock } from '../../../tests/mocks/envUtils.js'

// ---------------------------------------------------------------------------
// envUtils goes through the shared complete-surface mock: every export
// delegates to the REAL module except the config-home pair, which points at
// this suite's temp dir while it runs. afterAll() drops the overrides so
// later files in the same process see fully real behavior again (mock.module
// is process-global). History of the hand-rolled partial mocks that used to
// live here — and poisoned other files — is in tests/mocks/envUtils.ts.
// ---------------------------------------------------------------------------
let tmpDir = ''
const envUtilsMock = setupEnvUtilsMock({
  getClaudeConfigHomeDir: () => tmpDir,
  getTeamsDir: () => `${tmpDir}/teams`,
})
afterAll(() => {
  envUtilsMock.reset()
})

import {
  computeHitRate,
  tokenSignature,
  getStateFilePath,
  readState,
  writeStateAtomic,
  type CacheUsage,
  type CacheStatsState,
} from '../telemetry/cacheStats.js'

import {
  onResponse,
  getCacheStatsState,
  initCacheStatsState,
  _resetCacheStatsStateForTest,
} from '../telemetry/cacheStatsState.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function usage(input: number, create: number, read: number): CacheUsage {
  return {
    input_tokens: input,
    cache_creation_input_tokens: create,
    cache_read_input_tokens: read,
  }
}

// ---------------------------------------------------------------------------
// computeHitRate
// ---------------------------------------------------------------------------

describe('computeHitRate', () => {
  test('returns null for null input', () => {
    expect(computeHitRate(null)).toBeNull()
  })

  test('returns null when all fields are 0 (denominator = 0)', () => {
    expect(computeHitRate(usage(0, 0, 0))).toBeNull()
  })

  test('100% when all tokens are cache reads', () => {
    expect(computeHitRate(usage(0, 0, 1000))).toBe(100)
  })

  test('0% when no cache reads', () => {
    expect(computeHitRate(usage(1000, 0, 0))).toBe(0)
  })

  test('rounds to integer (50%)', () => {
    expect(computeHitRate(usage(500, 0, 500))).toBe(50)
  })

  test('rounds fractional values', () => {
    // read=1, total=3 → 33.33... → rounds to 33
    expect(computeHitRate(usage(2, 0, 1))).toBe(33)
  })

  test('handles large numbers without overflow', () => {
    const big = 1_000_000_000
    expect(computeHitRate(usage(big, big, big))).toBe(33)
  })

  test('cache_creation does not count as reads', () => {
    // Only cache_read_input_tokens in numerator
    expect(computeHitRate(usage(0, 1000, 0))).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// tokenSignature
// ---------------------------------------------------------------------------

describe('tokenSignature', () => {
  test('produces deterministic string', () => {
    const u = usage(100, 200, 300)
    expect(tokenSignature(u)).toBe('100|200|300')
  })

  test('changes when input_tokens changes', () => {
    expect(tokenSignature(usage(1, 2, 3))).not.toBe(
      tokenSignature(usage(9, 2, 3)),
    )
  })

  test('changes when cache_creation changes', () => {
    expect(tokenSignature(usage(1, 2, 3))).not.toBe(
      tokenSignature(usage(1, 9, 3)),
    )
  })

  test('changes when cache_read changes', () => {
    expect(tokenSignature(usage(1, 2, 3))).not.toBe(
      tokenSignature(usage(1, 2, 9)),
    )
  })
})

// ---------------------------------------------------------------------------
// State file: getStateFilePath
// ---------------------------------------------------------------------------

describe('getStateFilePath', () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-stats-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('returns path inside config home dir', () => {
    const p = getStateFilePath('session-abc')
    expect(p).toContain('cache-stats')
    expect(p.startsWith(tmpDir)).toBe(true)
  })

  test('different sessionIds produce different paths', () => {
    const p1 = getStateFilePath('session-one')
    const p2 = getStateFilePath('session-two')
    expect(p1).not.toBe(p2)
  })

  test('same sessionId always produces same path (deterministic)', () => {
    expect(getStateFilePath('s1')).toBe(getStateFilePath('s1'))
  })

  test('file name is 16 hex chars + .json', () => {
    const p = getStateFilePath('any-session-id')
    const base = path.basename(p)
    expect(base).toMatch(/^[0-9a-f]{16}\.json$/)
  })
})

// ---------------------------------------------------------------------------
// State file: readState / writeStateAtomic
// ---------------------------------------------------------------------------

describe('readState / writeStateAtomic', () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-stats-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('readState returns init defaults when file is missing', async () => {
    const p = path.join(tmpDir, 'cache-stats', 'nonexistent.json')
    const s = await readState(p)
    expect(s.version).toBe(1)
    expect(s.signature).toBeNull()
    expect(s.lastResetAt).toBeNull()
    expect(s.lastHitRate).toBeNull()
  })

  test('readState returns init defaults on corrupt JSON', async () => {
    const p = path.join(tmpDir, 'bad.json')
    await fsp.writeFile(p, 'not-json!!!', 'utf8')
    const s = await readState(p)
    expect(s.signature).toBeNull()
  })

  test('readState returns init defaults on invalid shape', async () => {
    const p = path.join(tmpDir, 'bad-shape.json')
    await fsp.writeFile(p, JSON.stringify({ version: 2, foo: 'bar' }), 'utf8')
    const s = await readState(p)
    expect(s.signature).toBeNull()
  })

  test('round-trip: writeStateAtomic then readState', async () => {
    const p = getStateFilePath('round-trip-session')
    const state: CacheStatsState = {
      version: 1,
      signature: '100|200|300',
      lastResetAt: 1_700_000_000_000,
      lastHitRate: 75,
    }
    await writeStateAtomic(p, state)
    const read = await readState(p)
    expect(read).toEqual(state)
  })

  test('writeStateAtomic creates parent directory if missing', async () => {
    const p = path.join(tmpDir, 'deep', 'nested', 'state.json')
    const state: CacheStatsState = {
      version: 1,
      signature: null,
      lastResetAt: null,
      lastHitRate: null,
    }
    await writeStateAtomic(p, state)
    const read = await readState(p)
    expect(read.version).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// onResponse / getCacheStatsState (in-memory singleton)
// ---------------------------------------------------------------------------

describe('onResponse', () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-stats-test-'))
    _resetCacheStatsStateForTest()
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('initial state has null signature and lastResetAt', () => {
    const s = getCacheStatsState()
    expect(s.signature).toBeNull()
    expect(s.lastResetAt).toBeNull()
  })

  test('first onResponse sets lastResetAt and signature', () => {
    const u = usage(100, 0, 50)
    const before = Date.now()
    const s = onResponse(u)
    const after = Date.now()
    expect(s.signature).toBe(tokenSignature(u))
    expect(s.lastResetAt).toBeGreaterThanOrEqual(before)
    expect(s.lastResetAt).toBeLessThanOrEqual(after)
    expect(s.lastHitRate).toBe(33) // 50/(100+50) ≈ 33
  })

  test('same signature does NOT reset lastResetAt', async () => {
    const u = usage(100, 0, 50)
    onResponse(u)
    const firstState = getCacheStatsState()
    const firstResetAt = firstState.lastResetAt

    // Wait a tick to ensure Date.now() would differ
    await new Promise(r => setTimeout(r, 5))

    onResponse(u) // same signature
    const secondState = getCacheStatsState()
    expect(secondState.lastResetAt).toBe(firstResetAt)
  })

  test('different signature RESETS lastResetAt', async () => {
    const u1 = usage(100, 0, 50)
    onResponse(u1)
    const firstState = getCacheStatsState()

    await new Promise(r => setTimeout(r, 5))

    const u2 = usage(200, 0, 100) // different signature
    onResponse(u2)
    const secondState = getCacheStatsState()
    expect(secondState.lastResetAt).toBeGreaterThan(firstState.lastResetAt!)
  })

  test('lastHitRate is updated on signature change', () => {
    onResponse(usage(1000, 0, 0)) // 0% hit rate
    const s1 = getCacheStatsState()
    expect(s1.lastHitRate).toBe(0)

    onResponse(usage(0, 0, 1000)) // 100% hit rate — different sig
    const s2 = getCacheStatsState()
    expect(s2.lastHitRate).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Multi-session isolation
// ---------------------------------------------------------------------------

describe('multi-session file isolation', () => {
  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cache-stats-test-'))
  })

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  })

  test('different session IDs produce different state files', async () => {
    const p1 = getStateFilePath('session-alpha')
    const p2 = getStateFilePath('session-beta')

    const s1: CacheStatsState = {
      version: 1,
      signature: 'sig-alpha',
      lastResetAt: 1000,
      lastHitRate: 90,
    }
    const s2: CacheStatsState = {
      version: 1,
      signature: 'sig-beta',
      lastResetAt: 2000,
      lastHitRate: 10,
    }

    await writeStateAtomic(p1, s1)
    await writeStateAtomic(p2, s2)

    const r1 = await readState(p1)
    const r2 = await readState(p2)

    expect(r1.signature).toBe('sig-alpha')
    expect(r2.signature).toBe('sig-beta')
    expect(r1.lastHitRate).toBe(90)
    expect(r2.lastHitRate).toBe(10)
  })

  test('initCacheStatsState loads persisted fallback values', async () => {
    _resetCacheStatsStateForTest()
    const sid = 'test-session-init'
    const p = getStateFilePath(sid)
    const persisted: CacheStatsState = {
      version: 1,
      signature: '500|100|400',
      lastResetAt: 1_700_000_000_000,
      lastHitRate: 40,
    }
    await writeStateAtomic(p, persisted)

    await initCacheStatsState(sid)
    const s = getCacheStatsState()
    expect(s.lastHitRate).toBe(40)
    expect(s.lastResetAt).toBe(1_700_000_000_000)
    expect(s.signature).toBe('500|100|400')
  })
})
