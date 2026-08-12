/**
 * Pure-data tests. addFlow.ts takes the registry and the spec table as
 * arguments and touches no fs, env or settings, so this file installs no
 * mocks; if one becomes necessary here, something side-effectful leaked in.
 */

import { describe, expect, test } from 'bun:test'
import type {
  ProviderProfile,
  ProviderProfilesFile,
} from 'src/services/providerProfiles/profiles.js'
import {
  addableProviderEntries,
  afterAggregateAnswered,
  afterKindChosen,
  afterNameSubmitted,
  beginAddFlow,
  describeAddOutcome,
  describeNonInteractiveAdd,
  validateNewProfileName,
  type AddProviderEntry,
  type SetupSpecView,
} from '../addFlow.js'

function profile(params: {
  name: string
  modelType?: string
  env?: Record<string, string>
}): ProviderProfile {
  return {
    name: params.name,
    modelType: (params.modelType ?? 'openai') as ProviderProfile['modelType'],
    env: params.env ?? {},
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

const SPECS: Record<string, SetupSpecView> = {
  openai: {
    modelType: 'openai',
    hasEndpointStep: true,
    defaultBaseUrl: 'https://api.openai.com/v1',
    title: ({ wireApi }) =>
      wireApi === 'responses'
        ? 'OpenAI Responses API Setup'
        : 'OpenAI Chat Completions Setup',
  },
  anthropic: {
    modelType: 'anthropic',
    hasEndpointStep: true,
    defaultBaseUrl: 'https://api.anthropic.com',
    title: () => 'Anthropic Compatible Setup',
  },
  china: {
    modelType: 'openai',
    hasEndpointStep: false,
    defaultBaseUrl: '',
    title: () => 'China Preset Setup',
  },
}

const ENTRY: AddProviderEntry = {
  kind: 'anthropic',
  value: 'anthropic',
  label: 'Anthropic Compatible',
  description: 'anthropic · https://api.anthropic.com',
  baseUrl: 'https://api.anthropic.com',
}

describe('addableProviderEntries', () => {
  test('one row per spec, from the spec table and nothing else', () => {
    const entries = addableProviderEntries(SPECS)
    // A provider added to the table later shows up here without an edit; the
    // only thing this module knows about any of them is which have a step 1.
    expect(entries.map(entry => entry.value)).toEqual([
      'openai:chat',
      'openai:responses',
      'anthropic',
    ])
  })

  test('a spec with no endpoint step is not offered', () => {
    // The China presets collect endpoint and key on screens of their own;
    // entering their wizard at step 1 would show a form they never use.
    expect(
      addableProviderEntries(SPECS).some(entry => entry.kind === 'china'),
    ).toBe(false)
  })

  test('labels come from the spec heading, lanes included', () => {
    const entries = addableProviderEntries(SPECS)
    expect(entries[0]).toMatchObject({
      kind: 'openai',
      wireApi: 'chat',
      label: 'OpenAI Chat Completions',
    })
    expect(entries[1]).toMatchObject({
      wireApi: 'responses',
      label: 'OpenAI Responses API',
    })
  })

  test('the form opens on the spec default, never on the live session', () => {
    // Seeding from process.env would prefill the ACTIVE provider's endpoint
    // into a form whose result is saved under a second name.
    expect(addableProviderEntries(SPECS)[2]).toMatchObject({
      baseUrl: 'https://api.anthropic.com',
    })
  })

  test('no entry mentions a credential or a credential key', () => {
    for (const entry of addableProviderEntries(SPECS)) {
      const text = `${entry.label} ${entry.description}`
      expect(text).not.toContain('API_KEY')
      expect(text).not.toContain('sk-')
    }
  })
})

describe('validateNewProfileName', () => {
  const file = registry(profile({ name: 'relay' }))

  test('accepts a free, shell-friendly name and trims it', () => {
    expect(validateNewProfileName(file, '  zen-go ')).toEqual({
      name: 'zen-go',
    })
  })

  test('refuses an empty name', () => {
    expect(validateNewProfileName(file, '   ')).toEqual({
      error: 'Give the profile a name.',
    })
  })

  test('refuses a name that cannot be typed as an argument', () => {
    const result = validateNewProfileName(file, 'my relay!')
    expect(result).toHaveProperty('error')
    expect((result as { error: string }).error).toContain(
      'Invalid profile name',
    )
  })

  test('refuses a name already in the registry', () => {
    // Overwriting would drop the other provider's endpoint and key.
    expect(validateNewProfileName(file, 'relay')).toEqual({
      error: 'A profile named "relay" already exists.',
    })
  })
})

describe('the flow', () => {
  test('starts on the provider menu', () => {
    expect(beginAddFlow()).toEqual({ step: 'kind' })
  })

  test('asks the user to name the new profile immediately after choosing a provider', () => {
    expect(afterKindChosen(ENTRY)).toEqual({
      step: 'name',
      entry: ENTRY,
      draft: '',
    })
  })

  test('a refused name keeps what was typed and says why', () => {
    const state = {
      step: 'name' as const,
      entry: ENTRY,
      draft: 'relay',
    }
    const next = afterNameSubmitted(state, registry(profile({ name: 'relay' })))
    expect(next).toMatchObject({ step: 'name', draft: 'relay' })
    expect((next as { error?: string }).error).toContain('already exists')
  })

  test('an accepted name moves on to the aggregate question, trimmed', () => {
    const next = afterNameSubmitted(
      { step: 'name', entry: ENTRY, draft: ' zen ' },
      { version: 1, profiles: {} },
    )
    expect(next).toEqual({ step: 'aggregate', entry: ENTRY, name: 'zen' })
  })

  test('the aggregate answer is carried into the setup step', () => {
    for (const aggregate of [true, false]) {
      expect(
        afterAggregateAnswered(
          { step: 'aggregate', entry: ENTRY, name: 'zen' },
          aggregate,
        ),
      ).toEqual({ step: 'setup', entry: ENTRY, name: 'zen', aggregate })
    }
  })
})

describe('describeAddOutcome', () => {
  test('says the session moved, every time', () => {
    // The wizard's save IS the activation, so the notice cannot leave that to
    // be discovered from the next request's model name.
    const outcome = describeAddOutcome({
      name: 'zen',
      aggregate: false,
      capture: { modelType: 'opencode' },
    })
    expect(outcome.notice).toContain('switched this session to it')
    expect(outcome).toMatchObject({ refreshCatalog: false })
  })

  test('opting in reads the model list, because a new profile has none', () => {
    const outcome = describeAddOutcome({
      name: 'zen',
      aggregate: true,
      capture: { modelType: 'opencode' },
    })
    expect(outcome).toMatchObject({ refreshCatalog: true })
  })

  test('a failed capture still leads with where the session ended up', () => {
    const outcome = describeAddOutcome({
      name: 'zen',
      aggregate: true,
      capture: { error: 'Provider "bedrock" is env-only.' },
    })
    expect(outcome.notice).toContain('This session is now using the provider')
    expect(outcome.notice).toContain('env-only')
    expect(outcome).toMatchObject({ refreshCatalog: false })
  })
})

describe('describeNonInteractiveAdd', () => {
  const file = registry(profile({ name: 'relay' }))

  test('names both ways to get the same registry entry', () => {
    const text = describeNonInteractiveAdd(file, undefined)
    expect(text).toContain('press A')
    expect(text).toContain('/provider-settings save <name>')
  })

  test('checks the name against the registry while it is here', () => {
    expect(describeNonInteractiveAdd(file, 'relay')).toContain('already exists')
    expect(describeNonInteractiveAdd(file, 'zen')).toContain(
      'The name "zen" is free.',
    )
  })

  test('never suggests passing a credential as an argument', () => {
    const text = describeNonInteractiveAdd(file, 'zen')
    expect(text).not.toContain('API_KEY')
    expect(text).not.toContain('sk-')
    expect(text).toContain('shell history')
  })
})
