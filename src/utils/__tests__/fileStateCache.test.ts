import { describe, expect, test } from 'bun:test'
import {
  FileStateCache,
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  mergeFileStateCaches,
} from '../fileStateCache.js'
import type { FileState } from '../fileStateCache.js'

function makeEntry(content: string, extra?: Partial<FileState>): FileState {
  return {
    content,
    timestamp: Date.now(),
    offset: undefined,
    limit: undefined,
    ...extra,
  }
}

/**
 * Mirrors coerceToolContentToString from queryHelpers.ts — not exported,
 * so we replicate it here to test the pattern.
 */
function coerceToolContentToString(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

describe('FileStateCache LRU eviction', () => {
  test('evicts oldest entries when max entries exceeded', () => {
    const cache = new FileStateCache(3, 1024 * 1024)
    cache.set('a', makeEntry('content-a'))
    cache.set('b', makeEntry('content-b'))
    cache.set('c', makeEntry('content-c'))
    cache.set('d', makeEntry('content-d')) // should evict 'a'

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.has('d')).toBe(true)
    expect(cache.size).toBe(3)
  })

  test('evicts entries when maxSizeBytes exceeded', () => {
    // Small size limit: 100 bytes
    const cache = new FileStateCache(100, 100)
    cache.set('a', makeEntry('x'.repeat(50))) // ~50 bytes
    cache.set('b', makeEntry('y'.repeat(50))) // ~50 bytes
    cache.set('c', makeEntry('z'.repeat(50))) // ~50 bytes, should evict 'a'

    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
    expect(cache.has('c')).toBe(true)
    expect(cache.calculatedSize).toBeLessThanOrEqual(100)
  })

  test('sizeCalculation handles string content', () => {
    const cache = new FileStateCache(100, 1000)
    cache.set('a', makeEntry('hello'))
    expect(cache.calculatedSize).toBeGreaterThan(0)
  })

  test('sizeCalculation handles object content via JSON.stringify', () => {
    const cache = new FileStateCache(100, 10000)
    const obj = { nested: { deep: 'value' } }
    cache.set('a', makeEntry(JSON.stringify(obj)))
    const size = cache.calculatedSize
    expect(size).toBeGreaterThan(0)
    // The JSON string should match the object's serialized length
    expect(size).toBe(Buffer.byteLength(JSON.stringify(obj), 'utf8'))
  })

  test('sizeCalculation handles null/undefined content', () => {
    const cache = new FileStateCache(100, 10000)
    cache.set('a', {
      content: null as unknown as string,
      timestamp: 0,
      offset: undefined,
      limit: undefined,
    })
    expect(cache.calculatedSize).toBe(1) // Math.max(1, 0) = 1
  })

  test('clear removes all entries', () => {
    const cache = new FileStateCache(100, 10000)
    cache.set('a', makeEntry('a'))
    cache.set('b', makeEntry('b'))
    cache.clear()
    expect(cache.size).toBe(0)
  })

  test('delete removes specific entry', () => {
    const cache = new FileStateCache(100, 10000)
    cache.set('a', makeEntry('a'))
    cache.set('b', makeEntry('b'))
    expect(cache.delete('a')).toBe(true)
    expect(cache.has('a')).toBe(false)
    expect(cache.has('b')).toBe(true)
  })

  test('normalizes path keys', () => {
    const cache = new FileStateCache(100, 10000)
    cache.set('/foo/../bar/baz.txt', makeEntry('content'))
    expect(cache.get('/bar/baz.txt')).toBeDefined()
    expect(cache.has('/bar/baz.txt')).toBe(true)
  })
})

describe('createFileStateCacheWithSizeLimit', () => {
  test('creates cache with default 25MB size limit', () => {
    const cache = createFileStateCacheWithSizeLimit(100)
    expect(cache.max).toBe(100)
    expect(cache.maxSize).toBe(25 * 1024 * 1024)
  })

  test('creates cache with custom size limit', () => {
    const cache = createFileStateCacheWithSizeLimit(50, 1024)
    expect(cache.max).toBe(50)
    expect(cache.maxSize).toBe(1024)
  })
})

describe('cloneFileStateCache', () => {
  test('copies the entries', () => {
    const source = createFileStateCacheWithSizeLimit(100)
    source.set('/repo/a.ts', makeEntry('alpha'))
    source.set('/repo/b.ts', makeEntry('beta'))

    const clone = cloneFileStateCache(source)

    expect(clone.size).toBe(2)
    expect(clone.get('/repo/a.ts')?.content).toBe('alpha')
    expect(clone.get('/repo/b.ts')?.content).toBe('beta')
  })

  test('preserves the entry and byte limits', () => {
    const source = createFileStateCacheWithSizeLimit(42, 4096)
    const clone = cloneFileStateCache(source)
    expect(clone.max).toBe(42)
    expect(clone.maxSize).toBe(4096)
  })

  test('shares FileState references with the source', () => {
    // Load-bearing, and the reason the fork path is cheap to copy but
    // expensive to leave lying around: lru-cache's dump() hands back the same
    // value objects, so a clone duplicates the index but not the file
    // contents. An outstanding clone therefore keeps the source's contents
    // alive — see scripts/bench-fork-file-state-cache.ts.
    const source = createFileStateCacheWithSizeLimit(100)
    source.set('/repo/a.ts', makeEntry('alpha'))

    const clone = cloneFileStateCache(source)

    expect(clone.get('/repo/a.ts')).toBe(source.get('/repo/a.ts'))
  })

  test('is an independent index: writes do not cross over', () => {
    const source = createFileStateCacheWithSizeLimit(100)
    source.set('/repo/a.ts', makeEntry('alpha'))

    const clone = cloneFileStateCache(source)
    clone.set('/repo/a.ts', makeEntry('edited-by-child'))
    clone.set('/repo/new.ts', makeEntry('child-only'))
    source.set('/repo/parent-only.ts', makeEntry('parent-only'))

    expect(source.get('/repo/a.ts')?.content).toBe('alpha')
    expect(source.has('/repo/new.ts')).toBe(false)
    expect(clone.has('/repo/parent-only.ts')).toBe(false)
  })

  test('clearing a clone leaves the source intact', () => {
    // What makes the subagent teardown safe: a fork child releasing its cache
    // must not blank the parent session's read state.
    const source = createFileStateCacheWithSizeLimit(100)
    source.set('/repo/a.ts', makeEntry('alpha'))

    const clone = cloneFileStateCache(source)
    clone.clear()

    expect(clone.size).toBe(0)
    expect(source.get('/repo/a.ts')?.content).toBe('alpha')
  })

  test('cloning twice is equivalent to cloning once', () => {
    // The fork path used to clone the parent, then clone that clone. Dropping
    // the intermediate copy is only safe because the two are indistinguishable
    // (runAgent.ts hands createSubagentContext no override on the fork path).
    const source = createFileStateCacheWithSizeLimit(100)
    source.set('/repo/a.ts', makeEntry('alpha'))
    source.set('/repo/b.ts', makeEntry('beta'))

    const once = cloneFileStateCache(source)
    const twice = cloneFileStateCache(cloneFileStateCache(source))

    // Snapshot the keys before touching get(): keys() walks the LRU's live
    // recency list and get() promotes the entry it finds to the head, so
    // reading during iteration rewires the list under the iterator and never
    // terminates.
    const keys = [...once.keys()]
    expect([...twice.keys()]).toEqual(keys)
    expect(twice.max).toBe(once.max)
    expect(twice.maxSize).toBe(once.maxSize)
    for (const key of keys) {
      expect(twice.get(key)).toBe(once.get(key))
    }
  })
})

describe('mergeFileStateCaches', () => {
  test('keeps the more recent entry per path', () => {
    const older = createFileStateCacheWithSizeLimit(100)
    older.set('/repo/a.ts', makeEntry('old', { timestamp: 10 }))
    const newer = createFileStateCacheWithSizeLimit(100)
    newer.set('/repo/a.ts', makeEntry('new', { timestamp: 20 }))

    expect(mergeFileStateCaches(older, newer).get('/repo/a.ts')?.content).toBe(
      'new',
    )
    expect(mergeFileStateCaches(newer, older).get('/repo/a.ts')?.content).toBe(
      'new',
    )
  })

  test('unions disjoint paths without mutating either input', () => {
    const first = createFileStateCacheWithSizeLimit(100)
    first.set('/repo/a.ts', makeEntry('alpha', { timestamp: 1 }))
    const second = createFileStateCacheWithSizeLimit(100)
    second.set('/repo/b.ts', makeEntry('beta', { timestamp: 1 }))

    const merged = mergeFileStateCaches(first, second)

    expect(merged.size).toBe(2)
    expect(first.size).toBe(1)
    expect(second.size).toBe(1)
    expect(first.has('/repo/b.ts')).toBe(false)
  })
})

describe('coerceToolContentToString', () => {
  test('returns string as-is', () => {
    expect(coerceToolContentToString('hello')).toBe('hello')
  })

  test('returns empty string for null', () => {
    expect(coerceToolContentToString(null)).toBe('')
  })

  test('returns empty string for undefined', () => {
    expect(coerceToolContentToString(undefined)).toBe('')
  })

  test('stringifies objects', () => {
    expect(coerceToolContentToString({ key: 'value' })).toBe('{"key":"value"}')
  })

  test('converts numbers to string', () => {
    expect(coerceToolContentToString(42)).toBe('42')
  })

  test('stringifies nested objects', () => {
    const nested = { a: { b: [1, 2, 3] } }
    expect(coerceToolContentToString(nested)).toBe('{"a":{"b":[1,2,3]}}')
  })
})
