/**
 * Pure-data tests: aggregate.ts touches no fs, no env and no settings, so this
 * file deliberately installs no mocks at all. If a mock ever becomes necessary
 * here, something side-effectful leaked into the module.
 */

import { describe, expect, test } from 'bun:test'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  buildAggregatedModels,
  formatModelSelector,
  parseModelSelector,
  resolveModelSelector,
} from '../aggregate.js'
import type { ProviderProfile, ProviderProfilesFile } from '../profiles.js'

function makeProfile(params: {
  name: string
  models?: CatalogModel[]
  aggregate?: boolean
}): ProviderProfile {
  return {
    name: params.name,
    modelType: 'openai',
    env: {},
    ...(params.models !== undefined ? { models: params.models } : {}),
    ...(params.aggregate !== undefined ? { aggregate: params.aggregate } : {}),
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
}

function registry(...profiles: ProviderProfile[]): ProviderProfilesFile {
  return {
    version: 1,
    profiles: Object.fromEntries(profiles.map(p => [p.name, p])),
  }
}

/** Every selector must survive format → parse → the pair it came from. */
function expectRoundTrip(file: ProviderProfilesFile): void {
  for (const model of buildAggregatedModels(file)) {
    const parsed = parseModelSelector(model.selector)
    expect(parsed.id).toBe(model.id)
    expect(parsed.profile).toBe(model.ambiguous ? model.profile : undefined)
  }
}

describe('buildAggregatedModels', () => {
  test('empty registry yields an empty list', () => {
    expect(buildAggregatedModels({ version: 1, profiles: {} })).toEqual([])
  })

  test('single profile: ids sorted, unique, selector is the bare id', () => {
    const file = registry(
      makeProfile({
        name: 'openai',
        aggregate: true,
        models: [
          { id: 'gpt-5.4' },
          { id: 'gpt-4.1', displayName: 'GPT-4.1' },
          { id: 'o5-mini' },
        ],
      }),
    )

    expect(buildAggregatedModels(file)).toEqual([
      {
        id: 'gpt-4.1',
        displayName: 'GPT-4.1',
        profile: 'openai',
        ambiguous: false,
        selector: 'gpt-4.1',
      },
      {
        id: 'gpt-5.4',
        profile: 'openai',
        ambiguous: false,
        selector: 'gpt-5.4',
      },
      {
        id: 'o5-mini',
        profile: 'openai',
        ambiguous: false,
        selector: 'o5-mini',
      },
    ])
    expectRoundTrip(file)
  })

  test('disjoint ids across profiles stay unqualified', () => {
    const file = registry(
      makeProfile({ name: 'zeta', aggregate: true, models: [{ id: 'a-1' }] }),
      makeProfile({ name: 'alpha', aggregate: true, models: [{ id: 'b-1' }] }),
    )

    const models = buildAggregatedModels(file)
    expect(models.map(m => m.selector)).toEqual(['a-1', 'b-1'])
    expect(models.every(m => !m.ambiguous)).toBe(true)
    expect(models.map(m => m.profile)).toEqual(['zeta', 'alpha'])
    expectRoundTrip(file)
  })

  test('a colliding id across 2 profiles is qualified on both rows', () => {
    const file = registry(
      makeProfile({
        name: 'relay',
        aggregate: true,
        models: [{ id: 'gpt-5.4', displayName: 'Relay GPT' }],
      }),
      makeProfile({
        name: 'official',
        aggregate: true,
        models: [{ id: 'gpt-5.4' }, { id: 'o5' }],
      }),
    )

    expect(buildAggregatedModels(file)).toEqual([
      {
        id: 'gpt-5.4',
        profile: 'official',
        ambiguous: true,
        selector: 'gpt-5.4@official',
      },
      {
        id: 'gpt-5.4',
        displayName: 'Relay GPT',
        profile: 'relay',
        ambiguous: true,
        selector: 'gpt-5.4@relay',
      },
      { id: 'o5', profile: 'official', ambiguous: false, selector: 'o5' },
    ])
    expectRoundTrip(file)
  })

  test('a colliding id across 3 profiles orders the cluster by profile', () => {
    const file = registry(
      makeProfile({ name: 'c', aggregate: true, models: [{ id: 'shared' }] }),
      makeProfile({ name: 'a', aggregate: true, models: [{ id: 'shared' }] }),
      makeProfile({ name: 'b', aggregate: true, models: [{ id: 'shared' }] }),
    )

    const models = buildAggregatedModels(file)
    expect(models.map(m => m.selector)).toEqual([
      'shared@a',
      'shared@b',
      'shared@c',
    ])
    expect(models.every(m => m.ambiguous)).toBe(true)
    expectRoundTrip(file)
  })

  test('ordering is stable across calls and independent of key order', () => {
    const forwards = registry(
      makeProfile({
        name: 'a',
        aggregate: true,
        models: [{ id: 'm2' }, { id: 'm1' }],
      }),
      makeProfile({ name: 'b', aggregate: true, models: [{ id: 'm1' }] }),
    )
    const backwards = registry(
      makeProfile({ name: 'b', aggregate: true, models: [{ id: 'm1' }] }),
      makeProfile({
        name: 'a',
        aggregate: true,
        models: [{ id: 'm1' }, { id: 'm2' }],
      }),
    )

    const first = buildAggregatedModels(forwards)
    expect(buildAggregatedModels(forwards)).toEqual(first)
    expect(buildAggregatedModels(backwards)).toEqual(first)
    expect(first.map(m => m.selector)).toEqual(['m1@a', 'm1@b', 'm2'])
  })
})

describe('buildAggregatedModels — non-participating profiles', () => {
  test('a profile without the aggregate opt-in contributes nothing', () => {
    const file = registry(
      makeProfile({ name: 'opted-in', aggregate: true, models: [{ id: 'x' }] }),
      makeProfile({ name: 'opted-out', models: [{ id: 'x' }, { id: 'y' }] }),
      makeProfile({
        name: 'explicit-off',
        aggregate: false,
        models: [{ id: 'x' }],
      }),
    )

    const models = buildAggregatedModels(file)
    // The opted-out copies of `x` must not make the opted-in one ambiguous.
    expect(models).toEqual([
      { id: 'x', profile: 'opted-in', ambiguous: false, selector: 'x' },
    ])
  })

  test('a missing snapshot is not an error and creates no ambiguity', () => {
    const file = registry(
      makeProfile({
        name: 'with-models',
        aggregate: true,
        models: [{ id: 'x' }],
      }),
      makeProfile({ name: 'no-snapshot', aggregate: true }),
      makeProfile({ name: 'empty-snapshot', aggregate: true, models: [] }),
    )

    expect(buildAggregatedModels(file)).toEqual([
      { id: 'x', profile: 'with-models', ambiguous: false, selector: 'x' },
    ])
  })

  test('a duplicate id inside one profile does not look like a collision', () => {
    const file = registry(
      makeProfile({
        name: 'dupes',
        aggregate: true,
        models: [{ id: 'x', displayName: 'First' }, { id: 'x' }],
      }),
    )

    expect(buildAggregatedModels(file)).toEqual([
      {
        id: 'x',
        displayName: 'First',
        profile: 'dupes',
        ambiguous: false,
        selector: 'x',
      },
    ])
  })

  test('garbage snapshots degrade to "contributes nothing" instead of throwing', () => {
    const file: ProviderProfilesFile = {
      version: 1,
      profiles: {
        broken: {
          ...makeProfile({ name: 'broken', aggregate: true }),
          models: 'not-an-array' as unknown as CatalogModel[],
        },
        partial: {
          ...makeProfile({ name: 'partial', aggregate: true }),
          models: [
            null,
            { id: 42 },
            { id: '' },
            { id: 'ok', displayName: 7 },
          ] as unknown as CatalogModel[],
        },
        // A null entry where a profile object should be (hand-edited file).
        nulled: null as unknown as ProviderProfile,
      },
    }

    expect(buildAggregatedModels(file)).toEqual([
      { id: 'ok', profile: 'partial', ambiguous: false, selector: 'ok' },
    ])
  })

  test('the registry key wins over a mismatched profile.name field', () => {
    const file: ProviderProfilesFile = {
      version: 1,
      profiles: {
        'key-name': {
          ...makeProfile({ name: 'stale-name', aggregate: true }),
          models: [{ id: 'x' }],
        },
      },
    }

    // The key is what activateProfile() resolves, so it must be what the
    // selector names.
    expect(buildAggregatedModels(file)[0]?.profile).toBe('key-name')
  })
})

describe('selectors for ids containing "@"', () => {
  test('a unique "@" id round-trips without being read as a qualifier', () => {
    const file = registry(
      makeProfile({
        name: '002',
        aggregate: true,
        models: [{ id: 'text-bison@002' }],
      }),
    )

    const models = buildAggregatedModels(file)
    expect(models[0]?.selector).toBe('text-bison@@002')
    // The trap: a naive last-"@" split would report profile "002" here.
    expect(parseModelSelector('text-bison@@002')).toEqual({
      id: 'text-bison@002',
    })
    expectRoundTrip(file)
  })

  test('an ambiguous "@" id keeps id and profile separable', () => {
    const file = registry(
      makeProfile({
        name: 'vertex',
        aggregate: true,
        models: [{ id: 'text-bison@002' }],
      }),
      makeProfile({
        name: 'relay',
        aggregate: true,
        models: [{ id: 'text-bison@002' }],
      }),
    )

    const models = buildAggregatedModels(file)
    expect(models.map(m => m.selector)).toEqual([
      'text-bison@@002@relay',
      'text-bison@@002@vertex',
    ])
    expect(parseModelSelector('text-bison@@002@vertex')).toEqual({
      id: 'text-bison@002',
      profile: 'vertex',
    })
    expectRoundTrip(file)
  })

  test('ids made of nothing but "@" still round-trip', () => {
    const ids = ['@', '@@', 'a@', '@a', 'a@@b', '@a@b@']
    const file = registry(
      makeProfile({
        name: 'weird',
        aggregate: true,
        models: ids.map(id => ({ id })),
      }),
      makeProfile({
        name: 'weird2',
        aggregate: true,
        models: ids.map(id => ({ id })),
      }),
    )

    // Every id here is ambiguous (both profiles serve it), so every selector
    // exercises the escape AND the qualifier at once.
    const models = buildAggregatedModels(file)
    expect(models).toHaveLength(ids.length * 2)
    expect(models.every(m => m.ambiguous)).toBe(true)
    expectRoundTrip(file)
  })
})

describe('parseModelSelector / formatModelSelector', () => {
  test('plain and qualified forms', () => {
    expect(parseModelSelector('gpt-5.4')).toEqual({ id: 'gpt-5.4' })
    expect(parseModelSelector('gpt-5.4@relay')).toEqual({
      id: 'gpt-5.4',
      profile: 'relay',
    })
  })

  test('empty selector yields an empty id', () => {
    expect(parseModelSelector('')).toEqual({ id: '' })
  })

  test('a dangling separator reads as unqualified', () => {
    expect(parseModelSelector('gpt-5.4@')).toEqual({ id: 'gpt-5.4' })
  })

  test('format is the inverse of parse', () => {
    const cases: Array<[string, string | undefined]> = [
      ['gpt-5.4', undefined],
      ['gpt-5.4', 'relay'],
      ['text-bison@002', undefined],
      ['text-bison@002', 'v-2'],
      ['@', 'p'],
      ['a@@b', undefined],
    ]
    for (const [id, profile] of cases) {
      const selector = formatModelSelector(id, profile)
      expect(parseModelSelector(selector)).toEqual(
        profile ? { id, profile } : { id },
      )
    }
  })
})

describe('resolveModelSelector', () => {
  const file = registry(
    makeProfile({
      name: 'official',
      aggregate: true,
      models: [{ id: 'gpt-5.4' }, { id: 'o5' }],
    }),
    makeProfile({
      name: 'relay',
      aggregate: true,
      models: [{ id: 'gpt-5.4' }, { id: 'text-bison@002' }],
    }),
    makeProfile({ name: 'hidden', models: [{ id: 'secret' }] }),
  )

  test('resolves a unique id to its owning profile', () => {
    expect(resolveModelSelector(file, 'o5')).toEqual({
      model: {
        id: 'o5',
        profile: 'official',
        ambiguous: false,
        selector: 'o5',
      },
    })
  })

  test('resolves a qualified selector to the named profile', () => {
    const result = resolveModelSelector(file, 'gpt-5.4@relay')
    expect(result).toMatchObject({ model: { id: 'gpt-5.4', profile: 'relay' } })
  })

  test('resolves an escaped "@" id', () => {
    expect(resolveModelSelector(file, 'text-bison@@002')).toMatchObject({
      model: { id: 'text-bison@002', profile: 'relay' },
    })
  })

  test('an ambiguous id without a qualifier is an error listing the options', () => {
    const result = resolveModelSelector(file, 'gpt-5.4')
    expect(result).toHaveProperty('error')
    const { error } = result as { error: string }
    expect(error).toContain('"gpt-5.4@official"')
    expect(error).toContain('"gpt-5.4@relay"')
  })

  test('an unknown id is an error, including models of non-aggregating profiles', () => {
    expect(resolveModelSelector(file, 'nope')).toHaveProperty('error')
    expect(resolveModelSelector(file, 'secret')).toHaveProperty('error')
  })

  test('a qualifier naming the wrong profile is an error', () => {
    const result = resolveModelSelector(file, 'o5@relay')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain('official')
  })
})
