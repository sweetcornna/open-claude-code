import { describe, expect, test } from 'bun:test'
import {
  MODEL_CATALOG_MAX_OPTIONS,
  isLikelyChatModel,
  type MergeableModelOption,
  mergeCatalogModelOptions,
} from '../merge.js'
import type { CatalogModel } from '../types.js'

const builtIn: MergeableModelOption[] = [
  { value: null, label: 'Default (recommended)', description: 'default' },
  { value: 'opus', label: 'Opus 4.7', description: 'opus' },
  { value: 'sonnet[1m]', label: 'Sonnet (1M context)', description: 'sonnet' },
]

describe('isLikelyChatModel', () => {
  test('keeps chat/completion models', () => {
    for (const id of [
      'gpt-5.6-sol',
      'claude-opus-4-7-20260115',
      'grok-4',
      'gemini-3-pro',
      'deepseek-chat',
    ]) {
      expect(isLikelyChatModel(id)).toBe(true)
    }
  })

  test('drops endpoints that cannot serve a main-loop turn', () => {
    for (const id of [
      'text-embedding-3-large',
      'whisper-1',
      'tts-1-hd',
      'dall-e-3',
      'omni-moderation-latest',
      'gpt-4o-realtime-preview',
      'gemini-2.5-flash-image',
      'imagen-4.0-generate-001',
      'veo-3.0-generate-001',
      'models-that-embed',
    ]) {
      expect(isLikelyChatModel(id)).toBe(false)
    }
  })
})

describe('mergeCatalogModelOptions', () => {
  test('returns the built-ins unchanged when there is no catalog', () => {
    expect(mergeCatalogModelOptions(builtIn, null)).toEqual(builtIn)
    expect(mergeCatalogModelOptions(builtIn, [])).toEqual(builtIn)
    expect(mergeCatalogModelOptions(builtIn, undefined)).toEqual(builtIn)
  })

  test('does not mutate the input array', () => {
    const input = [...builtIn]
    mergeCatalogModelOptions(input, [{ id: 'new-model' }])
    expect(input).toEqual(builtIn)
  })

  test('keeps built-ins first and in their exact original order', () => {
    const merged = mergeCatalogModelOptions(builtIn, [
      { id: 'brand-new-model' },
    ])
    expect(merged.slice(0, builtIn.length)).toEqual(builtIn)
    expect(merged[builtIn.length]?.value).toBe('brand-new-model')
  })

  test('dedupes by model id, ignoring case and the [1m] suffix', () => {
    const merged = mergeCatalogModelOptions(builtIn, [
      { id: 'sonnet' },
      { id: 'OPUS' },
      { id: 'opus[1m]' },
      { id: 'fresh-model' },
    ])
    expect(merged.map(option => option.value)).toEqual([
      null,
      'opus',
      'sonnet[1m]',
      'fresh-model',
    ])
  })

  test('dedupes repeats inside the catalog itself', () => {
    const merged = mergeCatalogModelOptions(builtIn, [
      { id: 'dupe' },
      { id: 'dupe' },
    ])
    expect(merged.filter(option => option.value === 'dupe')).toHaveLength(1)
  })

  test('orders appended models newest-first, then by id', () => {
    const catalog: CatalogModel[] = [
      { id: 'b-old', created: 100 },
      { id: 'a-new', created: 300 },
      { id: 'c-mid', created: 200 },
      { id: 'b-tie', created: 300 },
      { id: 'z-undated' },
    ]
    const merged = mergeCatalogModelOptions(builtIn, catalog)
    expect(merged.slice(builtIn.length).map(option => option.value)).toEqual([
      'a-new',
      'b-tie',
      'c-mid',
      'b-old',
      'z-undated',
    ])
  })

  test('is order-independent: shuffled input renders identically', () => {
    const catalog: CatalogModel[] = [
      { id: 'm1', created: 10 },
      { id: 'm2', created: 20 },
      { id: 'm3' },
    ]
    expect(mergeCatalogModelOptions(builtIn, catalog)).toEqual(
      mergeCatalogModelOptions(builtIn, [...catalog].reverse()),
    )
  })

  test('caps the merged list without ever dropping a built-in', () => {
    const catalog = Array.from({ length: 100 }, (_, index) => ({
      id: `model-${String(index).padStart(3, '0')}`,
    }))
    const merged = mergeCatalogModelOptions(builtIn, catalog)
    expect(merged).toHaveLength(MODEL_CATALOG_MAX_OPTIONS)
    expect(merged.slice(0, builtIn.length)).toEqual(builtIn)
  })

  test('honours an explicit maxTotal below the built-in count', () => {
    const merged = mergeCatalogModelOptions(builtIn, [{ id: 'extra' }], {
      maxTotal: 1,
    })
    expect(merged).toEqual(builtIn)
  })

  test('filters non-chat ids out of the appended block', () => {
    const merged = mergeCatalogModelOptions(builtIn, [
      { id: 'text-embedding-3-small' },
      { id: 'good-model' },
    ])
    expect(merged.map(option => option.value)).toEqual([
      null,
      'opus',
      'sonnet[1m]',
      'good-model',
    ])
  })

  test('labels an appended model with its display name when reported', () => {
    const [appended] = mergeCatalogModelOptions(
      [],
      [{ id: 'claude-x-1', displayName: 'Claude X' }],
    )
    expect(appended?.label).toBe('Claude X')
    expect(appended?.description).toContain('claude-x-1')
    expect(appended?.descriptionForModel).toContain('claude-x-1')
  })

  test('falls back to the raw id when no display name is reported', () => {
    const [appended] = mergeCatalogModelOptions([], [{ id: 'grok-9' }])
    expect(appended?.label).toBe('grok-9')
    expect(appended?.value).toBe('grok-9')
  })

  test('skips blank ids', () => {
    expect(mergeCatalogModelOptions([], [{ id: '   ' }])).toEqual([])
  })
})
