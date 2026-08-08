import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MODEL_CATALOG_FILENAME,
  MODEL_CATALOG_TTL_MS,
  buildCatalogKey,
  catalogKeyForProvider,
  getCachedModelCatalog,
  hasFreshModelCatalog,
  modelCatalogFilePath,
  readModelCatalogFile,
  resetModelCatalogCache,
  resolveProviderBaseURL,
  writeModelCatalogEntry,
} from '../cache.js'

/**
 * The config root is redirected with OCC_CONFIG_DIR rather than by mocking
 * envUtils: occConfigDir() memoizes on the env-var pair, so swapping the var
 * is both correct and free of process-global mock.module pollution.
 */
const savedConfigDir = process.env.OCC_CONFIG_DIR
const savedLegacyConfigDir = process.env.CLAUDE_CONFIG_DIR
const tmpRoot = mkdtempSync(join(tmpdir(), 'occ-model-catalog-'))

beforeEach(() => {
  process.env.OCC_CONFIG_DIR = tmpRoot
  delete process.env.CLAUDE_CONFIG_DIR
  resetModelCatalogCache()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  if (savedLegacyConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedLegacyConfigDir
  resetModelCatalogCache()
})

describe('resolveProviderBaseURL', () => {
  test('falls back to the documented default per provider', () => {
    expect(resolveProviderBaseURL('firstParty', {})).toBe(
      'https://api.anthropic.com',
    )
    expect(resolveProviderBaseURL('openai', {})).toBe(
      'https://api.openai.com/v1',
    )
    expect(resolveProviderBaseURL('gemini', {})).toBe(
      'https://generativelanguage.googleapis.com/v1beta',
    )
    expect(resolveProviderBaseURL('grok', {})).toBe('https://api.x.ai/v1')
  })

  test('honours the per-provider base URL env var and trims slashes', () => {
    expect(
      resolveProviderBaseURL('openai', {
        OPENAI_BASE_URL: 'http://localhost:11434/v1/',
      }),
    ).toBe('http://localhost:11434/v1')
  })

  test('returns null for cloud providers with no /models endpoint', () => {
    expect(resolveProviderBaseURL('bedrock', {})).toBeNull()
    expect(resolveProviderBaseURL('vertex', {})).toBeNull()
    expect(resolveProviderBaseURL('foundry', {})).toBeNull()
  })
})

describe('catalog key', () => {
  test('is scoped by provider and base URL', () => {
    const a = buildCatalogKey('openai', 'https://api.openai.com/v1')
    const b = buildCatalogKey('openai', 'https://gateway.example.com/v1')
    const c = buildCatalogKey('grok', 'https://api.openai.com/v1')
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
  })

  test('normalizes host/resource syntax without folding path or query case', () => {
    expect(
      buildCatalogKey(
        'openai',
        'https://API.OpenAI.com/v1/models///?Tenant=Prod',
      ),
    ).toBe(buildCatalogKey('openai', 'https://api.openai.com/v1?Tenant=Prod'))
    expect(
      buildCatalogKey('openai', 'https://gateway.example/Tenant?key=AbC'),
    ).not.toBe(
      buildCatalogKey('openai', 'https://gateway.example/tenant?key=abc'),
    )
  })

  test('catalogKeyForProvider is null for unsupported providers', () => {
    expect(catalogKeyForProvider('bedrock', {})).toBeNull()
    expect(catalogKeyForProvider('gemini', {})).toBe(
      buildCatalogKey(
        'gemini',
        'https://generativelanguage.googleapis.com/v1beta',
      ),
    )
  })
})

describe('disk cache', () => {
  const key = buildCatalogKey('openai', 'https://api.openai.com/v1')

  test('writes under the occ config dir, never a hand-built path', () => {
    expect(modelCatalogFilePath()).toBe(join(tmpRoot, MODEL_CATALOG_FILENAME))
  })

  test('round-trips an entry', () => {
    const now = 1_700_000_000_000
    expect(
      writeModelCatalogEntry(key, [{ id: 'gpt-9', created: 42 }], now),
    ).toBe(true)
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key, now)).toEqual([
      { id: 'gpt-9', created: 42 },
    ])
  })

  test('leaves no temp files behind (atomic write)', () => {
    writeModelCatalogEntry(key, [{ id: 'gpt-9' }])
    expect(readdirSync(tmpRoot).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  test('preserves other providers entries on write', () => {
    const now = 1_700_000_000_000
    const otherKey = buildCatalogKey('grok', 'https://api.x.ai/v1')
    writeModelCatalogEntry(key, [{ id: 'gpt-9' }], now)
    writeModelCatalogEntry(otherKey, [{ id: 'grok-9' }], now)
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key, now)).toEqual([{ id: 'gpt-9' }])
    expect(getCachedModelCatalog(otherKey, now)).toEqual([{ id: 'grok-9' }])
  })

  test('expires entries older than the TTL', () => {
    const now = 1_700_000_000_000
    writeModelCatalogEntry(key, [{ id: 'gpt-9' }], now)
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key, now + MODEL_CATALOG_TTL_MS - 1)).toEqual([
      { id: 'gpt-9' },
    ])
    expect(hasFreshModelCatalog(key, now + MODEL_CATALOG_TTL_MS - 1)).toBe(true)
    expect(
      getCachedModelCatalog(key, now + MODEL_CATALOG_TTL_MS + 1),
    ).toBeNull()
    expect(hasFreshModelCatalog(key, now + MODEL_CATALOG_TTL_MS + 1)).toBe(
      false,
    )
  })

  test('returns null for a missing key or a missing file', () => {
    expect(getCachedModelCatalog(null)).toBeNull()
    expect(getCachedModelCatalog('openai|https://nope')).toBeNull()
  })

  test('treats a corrupt file as no cache instead of throwing', () => {
    writeFileSync(modelCatalogFilePath(), 'not json at all')
    resetModelCatalogCache()
    expect(readModelCatalogFile()).toBeNull()
    expect(getCachedModelCatalog(key)).toBeNull()
  })

  test('rejects a file written by a different schema version', () => {
    writeFileSync(
      modelCatalogFilePath(),
      JSON.stringify({
        version: 999,
        entries: { [key]: { fetchedAt: Date.now(), models: [{ id: 'x' }] } },
      }),
    )
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key)).toBeNull()
  })

  test('drops malformed entries but keeps the valid ones', () => {
    const now = 1_700_000_000_000
    writeFileSync(
      modelCatalogFilePath(),
      JSON.stringify({
        version: 2,
        entries: {
          [key]: { fetchedAt: now, models: [{ id: 'ok' }, { nope: 1 }, 'x'] },
          broken: { models: [{ id: 'y' }] },
        },
      }),
    )
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key, now)).toEqual([{ id: 'ok' }])
    expect(getCachedModelCatalog('broken', now)).toBeNull()
  })

  test('an empty model list reads back as no cache', () => {
    const now = 1_700_000_000_000
    writeModelCatalogEntry(key, [], now)
    resetModelCatalogCache()
    expect(getCachedModelCatalog(key, now)).toBeNull()
  })

  test('persists valid JSON with the schema version', () => {
    writeModelCatalogEntry(key, [{ id: 'gpt-9' }])
    const raw: unknown = JSON.parse(
      readFileSync(modelCatalogFilePath(), 'utf8'),
    )
    expect((raw as { version: number }).version).toBe(2)
  })
})
