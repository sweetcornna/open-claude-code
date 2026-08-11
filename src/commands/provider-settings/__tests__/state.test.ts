/**
 * Pure-data tests. state.ts takes the registry as an argument and touches no
 * fs, env or settings, so this file installs no mocks; if one becomes
 * necessary here, something side-effectful leaked in.
 */

import { describe, expect, test } from 'bun:test'
import { buildAggregatedModels } from 'src/services/providerProfiles/aggregate.js'
import type { CatalogModel } from 'src/services/modelCatalog/types.js'
import type {
  ProviderProfile,
  ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'
import {
  buildProviderRows,
  describeAggregatedModels,
  describeAggregateOverview,
  describeCredential,
  describeProviderRows,
  EMPTY_REGISTRY_HINT,
  parseArgs,
  profileCredentialKey,
  profileEndpoint,
  summarizeAggregate,
  usage,
} from '../state.js'

function profile(params: {
  name: string
  modelType?: string
  env?: Record<string, string>
  models?: CatalogModel[]
  aggregate?: boolean
  notes?: string
}): ProviderProfile {
  return {
    name: params.name,
    modelType: (params.modelType ?? 'openai') as ProviderProfile['modelType'],
    env: params.env ?? {},
    ...(params.notes !== undefined ? { notes: params.notes } : {}),
    ...(params.models !== undefined ? { models: params.models } : {}),
    ...(params.aggregate !== undefined ? { aggregate: params.aggregate } : {}),
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
  }
}

function registry(
  active: string | undefined,
  ...profiles: ProviderProfile[]
): ProviderProfilesFile {
  return {
    version: 1,
    ...(active !== undefined ? { active } : {}),
    profiles: Object.fromEntries(profiles.map(p => [p.name, p])),
  }
}

describe('parseArgs', () => {
  test('no args opens the panel', () => {
    expect(parseArgs(undefined)).toEqual({ kind: 'panel' })
    expect(parseArgs('   ')).toEqual({ kind: 'panel' })
  })

  test('help forms', () => {
    for (const arg of ['help', '--help', '-h', '?', 'HELP']) {
      expect(parseArgs(arg)).toEqual({ kind: 'help' })
    }
  })

  test('listing verbs and their aliases', () => {
    for (const arg of ['list', 'ls', 'show', 'current', 'LIST']) {
      expect(parseArgs(arg)).toEqual({ kind: 'list' })
    }
    expect(parseArgs('models')).toEqual({ kind: 'models' })
  })

  test('use / switch / activate all address a profile', () => {
    for (const verb of ['use', 'switch', 'activate']) {
      expect(parseArgs(`${verb} relay`)).toEqual({ kind: 'use', name: 'relay' })
    }
  })

  test('profile names keep their case while verbs do not', () => {
    // isValidProfileName accepts upper case, so folding the name would address
    // a different profile — or none — and read as the command doing nothing.
    expect(parseArgs('USE MyRelay')).toEqual({ kind: 'use', name: 'MyRelay' })
  })

  test('save takes optional notes', () => {
    expect(parseArgs('save relay')).toEqual({ kind: 'save', name: 'relay' })
    expect(parseArgs('save relay work  account')).toEqual({
      kind: 'save',
      name: 'relay',
      notes: 'work account',
    })
  })

  test('delete and its aliases', () => {
    for (const verb of ['delete', 'rm', 'remove']) {
      expect(parseArgs(`${verb} relay`)).toEqual({
        kind: 'delete',
        name: 'relay',
      })
    }
  })

  test('refresh and its alias', () => {
    expect(parseArgs('refresh relay')).toEqual({
      kind: 'refresh',
      name: 'relay',
    })
    expect(parseArgs('fetch relay')).toEqual({ kind: 'refresh', name: 'relay' })
  })

  test('aggregate needs an explicit direction', () => {
    for (const on of ['on', 'true', 'yes', 'enable', '1']) {
      expect(parseArgs(`aggregate relay ${on}`)).toEqual({
        kind: 'aggregate',
        name: 'relay',
        enabled: true,
      })
    }
    for (const off of ['off', 'false', 'no', 'disable', '0']) {
      expect(parseArgs(`aggregate relay ${off}`)).toEqual({
        kind: 'aggregate',
        name: 'relay',
        enabled: false,
      })
    }
  })

  test('aggregate without a direction is an error, not a guess', () => {
    const result = parseArgs('aggregate relay')
    expect(result.kind).toBe('error')
    expect((result as { message: string }).message).toContain('on|off')
  })

  test('a verb missing its profile name is a usage error', () => {
    for (const verb of ['use', 'save', 'delete', 'refresh', 'aggregate']) {
      const result = parseArgs(verb)
      expect(result.kind).toBe('error')
      expect((result as { message: string }).message).toContain(verb)
    }
  })

  test('add takes an optional name', () => {
    expect(parseArgs('add')).toEqual({ kind: 'add' })
    expect(parseArgs('new zen')).toEqual({ kind: 'add', name: 'zen' })
  })

  test('rename needs both names and keeps their case', () => {
    expect(parseArgs('rename Old New')).toEqual({
      kind: 'rename',
      from: 'Old',
      to: 'New',
    })
    expect(parseArgs('mv old new')).toEqual({
      kind: 'rename',
      from: 'old',
      to: 'new',
    })
    for (const args of ['rename', 'rename only-one']) {
      const result = parseArgs(args)
      expect(result.kind).toBe('error')
      expect((result as { message: string }).message).toContain(
        'rename <old> <new>',
      )
    }
  })

  test('overview and its alias', () => {
    expect(parseArgs('overview')).toEqual({ kind: 'overview' })
    expect(parseArgs('summary')).toEqual({ kind: 'overview' })
  })

  test('an unknown verb reports itself and the usage block', () => {
    const result = parseArgs('frobnicate relay')
    expect(result.kind).toBe('error')
    const { message } = result as { message: string }
    expect(message).toContain('"frobnicate"')
    expect(message).toContain(usage())
  })
})

describe('profileEndpoint / profileCredentialKey', () => {
  test('reads the endpoint from whatever *_BASE_URL the profile carries', () => {
    expect(
      profileEndpoint(
        profile({
          name: 'p',
          env: { OPENAI_BASE_URL: 'https://relay.example/v1' },
        }),
      ),
    ).toBe('https://relay.example/v1')
  })

  test('a family added later is read without an edit here', () => {
    // Nothing in this module names OpenCode; the key table does.
    expect(
      profileEndpoint(
        profile({
          name: 'zen',
          modelType: 'opencode',
          env: { OPENCODE_BASE_URL: 'https://opencode.ai/zen/v1' },
        }),
      ),
    ).toBe('https://opencode.ai/zen/v1')
  })

  test('no endpoint means the provider default, not an error', () => {
    expect(profileEndpoint(profile({ name: 'p' }))).toBeUndefined()
  })

  test('finds the credential KEY and never needs its value', () => {
    const key = profileCredentialKey(
      profile({ name: 'p', env: { OPENAI_API_KEY: 'sk-secret' } }),
    )
    expect(key).toBe('OPENAI_API_KEY')
    expect(key).not.toContain('sk-')
  })

  test('an API key outranks an auth token', () => {
    // The model-list request sends the credential as an API key; a bearer
    // token in that header just 401s.
    expect(
      profileCredentialKey(
        profile({
          name: 'p',
          modelType: 'anthropic',
          env: { ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_API_KEY: 'k' },
        }),
      ),
    ).toBe('ANTHROPIC_API_KEY')
  })

  test('a mode name and a token COUNT are not credentials', () => {
    expect(
      profileCredentialKey(
        profile({
          name: 'p',
          env: {
            OPENAI_AUTH_MODE: 'chatgpt',
            CLAUDE_CODE_MAX_CONTEXT_TOKENS: '272000',
          },
        }),
      ),
    ).toBeUndefined()
  })

  test('an OAuth-only profile reports no credential', () => {
    const row = buildProviderRows(
      registry(undefined, profile({ name: 'claude', modelType: 'anthropic' })),
    )[0]!
    expect(row.hasCredential).toBe(false)
    expect(describeCredential(row)).toContain('OAuth')
  })
})

describe('buildProviderRows', () => {
  test('empty registry yields no rows', () => {
    expect(buildProviderRows({ version: 1, profiles: {} })).toEqual([])
  })

  test('rows carry the registry key, ordered on codepoints', () => {
    // Codepoint order, not localeCompare: the panel's row order must not
    // depend on the machine's ICU collation.
    const rows = buildProviderRows(
      registry(
        undefined,
        profile({ name: 'zeta' }),
        profile({ name: 'Alpha' }),
        profile({ name: 'alpha' }),
      ),
    )
    expect(rows.map(r => r.name)).toEqual(['Alpha', 'alpha', 'zeta'])
  })

  test('a mismatched profile.name does not win over the registry key', () => {
    const file: ProviderProfilesFile = {
      version: 1,
      profiles: { 'key-name': profile({ name: 'stale-name' }) },
    }
    expect(buildProviderRows(file)[0]!.name).toBe('key-name')
  })

  test('active, aggregate and model count come through', () => {
    const rows = buildProviderRows(
      registry(
        'relay',
        profile({
          name: 'relay',
          aggregate: true,
          models: [{ id: 'a' }, { id: 'b' }],
          notes: 'work',
        }),
        profile({ name: 'other' }),
      ),
    )
    expect(rows.find(r => r.name === 'relay')).toMatchObject({
      active: true,
      aggregate: true,
      modelCount: 2,
      notes: 'work',
    })
    expect(rows.find(r => r.name === 'other')).toMatchObject({
      active: false,
      aggregate: false,
      modelCount: 0,
    })
  })

  test('garbage entries degrade instead of throwing', () => {
    const file: ProviderProfilesFile = {
      version: 1,
      profiles: {
        nulled: null as unknown as ProviderProfile,
        broken: {
          ...profile({ name: 'broken' }),
          models: 'nope' as unknown as CatalogModel[],
          modelType: 7 as unknown as ProviderProfile['modelType'],
        },
      },
    }
    const rows = buildProviderRows(file)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: 'broken',
      modelType: 'unknown',
      modelCount: 0,
    })
  })
})

describe('describeProviderRows', () => {
  test('the empty registry says how to get out of it', () => {
    expect(
      describeProviderRows(buildProviderRows({ version: 1, profiles: {} }), []),
    ).toBe(EMPTY_REGISTRY_HINT)
  })

  test('marks the active profile and the aggregate opt-ins', () => {
    const file = registry(
      'relay',
      profile({
        name: 'relay',
        aggregate: true,
        models: [{ id: 'a' }],
        env: { OPENAI_BASE_URL: 'https://relay.example/v1' },
      }),
      profile({ name: 'other' }),
    )
    const text = describeProviderRows(
      buildProviderRows(file),
      buildAggregatedModels(file),
    )
    expect(text).toContain('*  [x]  relay')
    expect(text).toContain('   [ ]  other')
    expect(text).toContain('https://relay.example/v1')
    expect(text).toContain('(provider default endpoint)')
  })

  test('never prints a credential, only its presence', () => {
    const file = registry(
      undefined,
      profile({
        name: 'relay',
        env: {
          OPENAI_BASE_URL: 'https://relay.example/v1',
          OPENAI_API_KEY: 'sk-do-not-print-me',
        },
      }),
    )
    const text = describeProviderRows(
      buildProviderRows(file),
      buildAggregatedModels(file),
    )
    expect(text).not.toContain('sk-do-not-print-me')
    expect(text).not.toContain('OPENAI_API_KEY')
    expect(text).toContain('key saved')
  })
})

describe('summarizeAggregate', () => {
  test('a fresh registry reads as "nobody opted in", not as broken', () => {
    const file = registry(undefined, profile({ name: 'relay' }))
    expect(
      summarizeAggregate(buildProviderRows(file), buildAggregatedModels(file)),
    ).toContain('no profile has opted in')
  })

  test('opted in but never refreshed says which fix applies', () => {
    const file = registry(
      undefined,
      profile({ name: 'relay', aggregate: true }),
    )
    const text = summarizeAggregate(
      buildProviderRows(file),
      buildAggregatedModels(file),
    )
    expect(text).toContain('no model snapshot yet')
    expect(text).toContain('/provider-settings refresh relay')
  })

  test('counts models, profiles and collisions', () => {
    const file = registry(
      undefined,
      profile({
        name: 'a',
        aggregate: true,
        models: [{ id: 'shared' }, { id: 'x' }],
      }),
      profile({ name: 'b', aggregate: true, models: [{ id: 'shared' }] }),
    )
    const text = summarizeAggregate(
      buildProviderRows(file),
      buildAggregatedModels(file),
    )
    expect(text).toContain('3 models')
    expect(text).toContain('2 profile(s)')
    expect(text).toContain('2 of them served by more than one')
  })
})

describe('describeAggregateOverview', () => {
  const shared = registry(
    undefined,
    profile({
      name: 'official',
      aggregate: true,
      models: [{ id: 'gpt-5.4' }, { id: 'o5' }],
    }),
    profile({
      name: 'relay',
      aggregate: true,
      models: [{ id: 'gpt-5.4' }, { id: 'glm-5' }],
    }),
    profile({ name: 'unused', models: [{ id: 'never-listed' }] }),
  )

  function lines(
    file: ProviderProfilesFile,
    limits?: { contributors?: number; collisions?: number },
  ): string[] {
    return describeAggregateOverview(
      buildProviderRows(file),
      buildAggregatedModels(file),
      limits,
    )
  }

  test('the headline is the same sentence the one-liner gives', () => {
    // Two renderings of the aggregate that disagree is the failure this
    // shares an implementation to avoid.
    expect(lines(shared)[0]).toBe(
      summarizeAggregate(
        buildProviderRows(shared),
        buildAggregatedModels(shared),
      ),
    )
  })

  test('names who contributes and how much', () => {
    const text = lines(shared).join('\n')
    expect(text).toContain('official 2')
    expect(text).toContain('relay 2')
    // Opted out, so it feeds nothing and is not listed as feeding anything.
    expect(text).not.toContain('unused')
  })

  test('counts what the union kept, not what the snapshot claimed', () => {
    // A provider listing the same id twice contributes it once, so the row's
    // "2 models" and the picker's one entry are both true.
    const file = registry(
      undefined,
      profile({
        name: 'dupe',
        aggregate: true,
        models: [{ id: 'a' }, { id: 'a' }],
      }),
    )
    expect(lines(file).join('\n')).toContain('dupe 1')
  })

  test('names the ids two providers both answer to', () => {
    // These are exactly the rows the picker renders as `id (profile)`; until
    // they are named the tag reads as a rendering quirk.
    const text = lines(shared).join('\n')
    expect(text).toContain('shared ids: gpt-5.4 (official, relay)')
    expect(text).not.toContain('glm-5')
  })

  test('nothing shared means no collision line at all', () => {
    const file = registry(
      undefined,
      profile({ name: 'a', aggregate: true, models: [{ id: 'x' }] }),
    )
    expect(lines(file).some(line => line.includes('shared ids'))).toBe(false)
  })

  test('an empty aggregate is one line, still saying how to fix it', () => {
    const file = registry(undefined, profile({ name: 'a' }))
    expect(lines(file)).toEqual([
      summarizeAggregate(buildProviderRows(file), buildAggregatedModels(file)),
    ])
  })

  test('limits truncate with a count, so the panel cannot overflow', () => {
    const text = lines(shared, { contributors: 1, collisions: 0 }).join('\n')
    expect(text).toContain('official 2 · +1 more')
    expect(text).toContain('shared ids: +1 more')
  })

  test('never prints a credential or the name of one', () => {
    const file = registry(
      undefined,
      profile({
        name: 'relay',
        aggregate: true,
        models: [{ id: 'gpt-5.4' }],
        env: {
          OPENAI_BASE_URL: 'https://relay.example/v1',
          OPENAI_API_KEY: 'sk-do-not-print-me',
        },
      }),
    )
    const text = lines(file).join('\n')
    expect(text).not.toContain('sk-do-not-print-me')
    expect(text).not.toContain('OPENAI_API_KEY')
  })
})

describe('describeAggregatedModels', () => {
  test('the empty union explains the opt-in', () => {
    expect(describeAggregatedModels([])).toContain('aggregate <name> on')
  })

  test('one row per (id, profile), collisions flagged', () => {
    const file = registry(
      undefined,
      profile({
        name: 'official',
        aggregate: true,
        models: [{ id: 'gpt-5.4' }],
      }),
      profile({
        name: 'relay',
        aggregate: true,
        models: [{ id: 'gpt-5.4' }, { id: 'glm-5' }],
      }),
    )
    const lines = describeAggregatedModels(buildAggregatedModels(file)).split(
      '\n',
    )
    expect(lines[0]).toContain('Aggregated models (3)')
    expect(lines.filter(l => l.includes('gpt-5.4'))).toHaveLength(2)
    expect(lines.filter(l => l.includes('shared id'))).toHaveLength(2)
    expect(lines.find(l => l.includes('glm-5'))).toContain('relay')
  })
})
