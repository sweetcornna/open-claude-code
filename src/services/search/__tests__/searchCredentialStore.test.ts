/**
 * The pinned-search-credential store.
 *
 * No module mocks at all: everything here is a real file under a temporary
 * OCC_CONFIG_DIR, which is also the only way to assert the two properties that
 * matter — that the file lands inside occ's own config root (never `~/.claude`,
 * never a bare homedir join) and that it is written 0600.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { occConfigDir } from 'src/config/paths.js'
import {
  isPinnableSearchSource,
  listPinnedSearchSources,
  PINNABLE_SEARCH_SOURCES,
  pinSearchCredential,
  readPinnedSearchCredential,
  reloadPinnedSearchCredentials,
  searchCredentialsFilePath,
  UnpinnableSearchSourceError,
  unpinSearchCredential,
} from '../searchCredentialStore.js'

const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-search-store-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
  reloadPinnedSearchCredentials()
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

describe('searchCredentialsFilePath', () => {
  test('lives inside the occ config root, so OCC_CONFIG_DIR moves it', () => {
    expect(searchCredentialsFilePath()).toBe(
      join(tempDir, 'search-credentials.json'),
    )
  })

  test('is not settings.json — the file users paste into bug reports', () => {
    expect(searchCredentialsFilePath()).not.toContain('settings.json')
  })
})

describe('pinSearchCredential', () => {
  test('round-trips a credential with its endpoint', async () => {
    await pinSearchCredential('deepseek', {
      apiKey: 'sk-deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
    })

    expect(readPinnedSearchCredential('deepseek')).toMatchObject({
      apiKey: 'sk-deepseek',
      baseURL: 'https://api.deepseek.com/anthropic',
    })
  })

  test('records when it was pinned, and never anything derived from the key', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })

    const stored = readPinnedSearchCredential('gemini')
    expect(stored?.pinnedAt).toBeString()
    expect(Object.keys(stored ?? {}).sort()).toEqual(['apiKey', 'pinnedAt'])
  })

  test('writes the file 0600', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })

    // eslint-disable-next-line no-bitwise
    expect(statSync(searchCredentialsFilePath()).mode & 0o777).toBe(0o600)
  })

  test('keeps sources independent — pinning one leaves the others alone', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })
    await pinSearchCredential('deepseek', { apiKey: 'sk-deepseek' })

    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe('AIza-secret')
    expect(readPinnedSearchCredential('deepseek')?.apiKey).toBe('sk-deepseek')
    expect(listPinnedSearchSources()).toEqual(['deepseek', 'gemini'])
  })

  test('replaces a previous pin for the same source', async () => {
    await pinSearchCredential('gemini', { apiKey: 'old' })
    await pinSearchCredential('gemini', { apiKey: 'new' })

    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe('new')
  })

  test('refuses an empty key rather than storing an unusable credential', async () => {
    await expect(
      pinSearchCredential('gemini', { apiKey: '   ' }),
    ).rejects.toThrow(/empty/i)
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('stores codex like any other family, now that its lane has a seam', async () => {
    // createOpenAIResponsesStream grew an optional `credential`, so the key
    // reaches the wire instead of sitting on disk under a green row.
    expect(isPinnableSearchSource('codex')).toBe(true)

    await pinSearchCredential('codex', {
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
    })

    expect(readPinnedSearchCredential('codex')).toMatchObject({
      apiKey: 'sk-openai',
      baseURL: 'https://api.openai.com/v1',
    })
  })

  test('the registry is still the gate, not a formality', async () => {
    // A family whose request layer has no credential seam must be refused
    // rather than stored-and-ignored. Reached through a cast because every
    // family in the union qualifies today — the guard is for the next one.
    const seamless = 'brave' as unknown as SearchCredentialFamily
    expect(isPinnableSearchSource(seamless)).toBe(false)
    await expect(
      pinSearchCredential(seamless, { apiKey: 'sk-whatever' }),
    ).rejects.toBeInstanceOf(UnpinnableSearchSourceError)
  })

  test('PINNABLE_SEARCH_SOURCES is the four lanes that read the store', () => {
    expect([...PINNABLE_SEARCH_SOURCES]).toEqual([
      'anthropic',
      'deepseek',
      'gemini',
      'codex',
    ])
  })
})

describe('unpinSearchCredential', () => {
  test('removes one source and keeps the rest', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })
    await pinSearchCredential('deepseek', { apiKey: 'sk-deepseek' })

    expect(await unpinSearchCredential('gemini')).toBe(true)

    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
    expect(readPinnedSearchCredential('deepseek')?.apiKey).toBe('sk-deepseek')
  })

  test('removes the file once nothing is pinned', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })

    expect(await unpinSearchCredential('gemini')).toBe(true)

    expect(listPinnedSearchSources()).toEqual([])
    reloadPinnedSearchCredentials()
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('reports that there was nothing to remove', async () => {
    expect(await unpinSearchCredential('gemini')).toBe(false)
  })
})

describe('reading a file this process did not write', () => {
  test('an absent file means nothing is pinned', () => {
    expect(listPinnedSearchSources()).toEqual([])
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('malformed JSON reads as nothing pinned rather than throwing', () => {
    // This probe is called from a settings-panel render and from every
    // createAdapter(); it must never be the thing that throws.
    writeFileSync(searchCredentialsFilePath(), '{ not json', { mode: 0o600 })
    reloadPinnedSearchCredentials()

    expect(() => listPinnedSearchSources()).not.toThrow()
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('an entry with an endpoint but no key is not a partial credential', () => {
    // Completing it from env is exactly what pinning exists to stop: the
    // endpoint would then carry whatever key the provider plane happened to
    // hold at request time.
    writeFileSync(
      searchCredentialsFilePath(),
      JSON.stringify({
        version: 1,
        sources: { gemini: { baseURL: 'https://example.invalid' } },
      }),
      { mode: 0o600 },
    )
    reloadPinnedSearchCredentials()

    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })

  test('reloadPinnedSearchCredentials picks up an external edit', async () => {
    await pinSearchCredential('gemini', { apiKey: 'AIza-secret' })
    writeFileSync(
      searchCredentialsFilePath(),
      JSON.stringify({ version: 1, sources: {} }),
      { mode: 0o600 },
    )

    // Still cached — the read path is memoized because it runs per row per
    // render of /search-setting.
    expect(readPinnedSearchCredential('gemini')?.apiKey).toBe('AIza-secret')

    reloadPinnedSearchCredentials()
    expect(readPinnedSearchCredential('gemini')).toBeUndefined()
  })
})
