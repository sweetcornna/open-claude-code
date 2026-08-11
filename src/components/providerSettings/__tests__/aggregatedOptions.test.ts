/**
 * Pure-data tests: aggregatedOptions.ts touches no fs, no env and no settings,
 * so this file installs no mocks at all. If one ever becomes necessary here,
 * something side-effectful leaked into the module.
 */

import { describe, expect, test } from 'bun:test'
import {
  buildAggregatedModels,
  type AggregatedModel,
} from 'src/services/providerProfiles/aggregate.js'
import type {
  ProviderProfile,
  ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import {
  AGGREGATED_OPTION_PREFIX,
  aggregatedOptionValue,
  buildAggregatedModelOptions,
  describeAggregatedModel,
  parseAggregatedOptionValue,
} from '../aggregatedOptions.js'

function profile(params: {
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

function model(
  params: Partial<AggregatedModel> & { id: string },
): AggregatedModel {
  return {
    profile: 'p',
    ambiguous: false,
    selector: params.id,
    ...params,
  }
}

describe('option value encoding', () => {
  test('round-trips a plain id', () => {
    const value = aggregatedOptionValue('gpt-5.4')
    expect(value).toBe(`${AGGREGATED_OPTION_PREFIX}gpt-5.4`)
    expect(parseAggregatedOptionValue(value)).toEqual({
      selector: 'gpt-5.4',
      id: 'gpt-5.4',
    })
  })

  test('round-trips a qualified selector', () => {
    const value = aggregatedOptionValue('gpt-5.4@relay')
    expect(parseAggregatedOptionValue(value)).toEqual({
      selector: 'gpt-5.4@relay',
      id: 'gpt-5.4',
      profile: 'relay',
    })
  })

  test('round-trips an id whose own "@" is doubled', () => {
    // The trap the storage layer's escaping exists for: a naive split would
    // report profile "002" here.
    const value = aggregatedOptionValue('text-bison@@002')
    expect(parseAggregatedOptionValue(value)).toEqual({
      selector: 'text-bison@@002',
      id: 'text-bison@002',
    })

    const qualified = aggregatedOptionValue('text-bison@@002@vertex')
    expect(parseAggregatedOptionValue(qualified)).toEqual({
      selector: 'text-bison@@002@vertex',
      id: 'text-bison@002',
      profile: 'vertex',
    })
  })

  test('every selector the storage layer emits survives the picker', () => {
    const ids = ['gpt-5.4', 'text-bison@002', '@', 'a@@b', '@a@b@']
    const file = registry(
      profile({
        name: 'one',
        aggregate: true,
        models: ids.map(id => ({ id })),
      }),
      profile({ name: 'two', aggregate: true, models: [{ id: 'gpt-5.4' }] }),
    )

    for (const aggregated of buildAggregatedModels(file)) {
      const parsed = parseAggregatedOptionValue(
        aggregatedOptionValue(aggregated.selector),
      )
      expect(parsed?.selector).toBe(aggregated.selector)
      expect(parsed?.id).toBe(aggregated.id)
      expect(parsed?.profile).toBe(
        aggregated.ambiguous ? aggregated.profile : undefined,
      )
    }
  })

  test('ordinary picker values are not aggregated values', () => {
    // Every one of these reaches settingsSlotForOption in the real picker; if
    // any were read as an aggregated row it would bypass the tier lookup.
    for (const value of [
      undefined,
      '',
      'opus',
      'sonnet[1m]',
      'claude-opus-5',
      'gpt-5.4',
      'text-bison@002',
      '__NO_PREFERENCE__',
    ]) {
      expect(parseAggregatedOptionValue(value)).toBeUndefined()
    }
  })

  test('a prefix with nothing behind it is not a row', () => {
    expect(parseAggregatedOptionValue(AGGREGATED_OPTION_PREFIX)).toBeUndefined()
    // `@relay` parses to an empty id, which names no model.
    expect(
      parseAggregatedOptionValue(`${AGGREGATED_OPTION_PREFIX}@relay`),
    ).toBeUndefined()
  })

  test('a model id that spells a tier alias stays namespaced', () => {
    // The whole reason for the prefix: this must never look like `/model opus`.
    const value = aggregatedOptionValue('opus')
    expect(value).not.toBe('opus')
    expect(parseAggregatedOptionValue(value)).toEqual({
      selector: 'opus',
      id: 'opus',
    })
  })
})

describe('buildAggregatedModelOptions', () => {
  test('an empty aggregate produces no rows', () => {
    expect(buildAggregatedModelOptions([])).toEqual([])
    expect(
      buildAggregatedModelOptions(
        buildAggregatedModels({ version: 1, profiles: {} }),
      ),
    ).toEqual([])
  })

  test('an unambiguous row is labelled with just its id', () => {
    const options = buildAggregatedModelOptions([
      model({ id: 'gpt-5.4', profile: 'official' }),
    ])
    expect(options).toHaveLength(1)
    expect(options[0]!.label).toBe('gpt-5.4')
    expect(options[0]!.value).toBe(aggregatedOptionValue('gpt-5.4'))
    // Even an unlabelled row names its owner somewhere: selecting it switches
    // provider, which is not a thing to discover afterwards.
    expect(options[0]!.description).toContain('official')
  })

  test('an ambiguous row is tagged with its owning provider', () => {
    const file = registry(
      profile({ name: 'relay', aggregate: true, models: [{ id: 'gpt-5.4' }] }),
      profile({
        name: 'official',
        aggregate: true,
        models: [{ id: 'gpt-5.4' }, { id: 'o5' }],
      }),
    )

    const options = buildAggregatedModelOptions(buildAggregatedModels(file))
    expect(options.map(o => o.label)).toEqual([
      'gpt-5.4 (official)',
      'gpt-5.4 (relay)',
      'o5',
    ])
    expect(
      options.map(o => parseAggregatedOptionValue(o.value)?.profile),
    ).toEqual(['official', 'relay', undefined])
  })

  test('order follows the storage layer, not the local collation', () => {
    const file = registry(
      profile({
        name: 'z',
        aggregate: true,
        models: [{ id: 'B-2' }, { id: 'a-1' }],
      }),
      profile({ name: 'a', aggregate: true, models: [{ id: 'C-3' }] }),
    )
    // Codepoint order puts upper case first; localeCompare would not.
    expect(
      buildAggregatedModelOptions(buildAggregatedModels(file)).map(
        o => o.label,
      ),
    ).toEqual(['B-2', 'C-3', 'a-1'])
  })

  test('the active profile does not re-offer a model already in the picker', () => {
    const models = [
      model({ id: 'gpt-5.4', profile: 'official' }),
      model({ id: 'o5', profile: 'official' }),
      model({ id: 'glm-5', profile: 'relay' }),
    ]
    const options = buildAggregatedModelOptions(models, {
      existingValues: new Set(['gpt-5.4', 'opus', 'sonnet']),
      activeProfile: 'official',
    })
    expect(options.map(o => o.label)).toEqual(['o5', 'glm-5'])
  })

  test('another profile serving a listed id is still offered', () => {
    // The base row belongs to the session's own provider; this one is a
    // different endpoint that happens to answer to the same name.
    const options = buildAggregatedModelOptions(
      [model({ id: 'gpt-5.4', profile: 'relay' })],
      { existingValues: new Set(['gpt-5.4']), activeProfile: 'official' },
    )
    expect(options).toHaveLength(1)
    expect(parseAggregatedOptionValue(options[0]!.value)?.id).toBe('gpt-5.4')
  })

  test('with no active profile nothing is deduped away', () => {
    const options = buildAggregatedModelOptions(
      [model({ id: 'gpt-5.4', profile: 'official' })],
      { existingValues: new Set(['gpt-5.4']) },
    )
    expect(options).toHaveLength(1)
  })

  test('a duplicated row from a hand-edited registry is dropped', () => {
    const duplicate = model({ id: 'x', profile: 'p' })
    expect(buildAggregatedModelOptions([duplicate, duplicate])).toHaveLength(1)
  })
})

describe('describeAggregatedModel', () => {
  test('leads with the provider name when there is no display name', () => {
    expect(describeAggregatedModel(model({ id: 'x', profile: 'relay' }))).toBe(
      'relay profile · selecting switches provider',
    )
  })

  test('keeps a reported display name in front', () => {
    expect(
      describeAggregatedModel(
        model({ id: 'x', profile: 'relay', displayName: 'Big X' }),
      ),
    ).toBe('Big X · relay profile · selecting switches provider')
  })
})
