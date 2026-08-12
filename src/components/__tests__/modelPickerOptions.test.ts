/**
 * The two picker helpers an aggregated row flows through.
 *
 * No mocks: both functions are pure over `process.env`, and the aggregated
 * branch short-circuits before anything that would need auth or settings. The
 * point of the file is the boundary — a selector must resolve to the model the
 * OWNING provider serves, and must never be read as one of occ's tier aliases,
 * because that would silently re-point the alias's effort and max-context
 * settings and hand `/model` a different model than the row named.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  canEditSettingsForOption,
  resolveOptionModel,
  settingsSlotForOption,
} from '../ModelPicker.js'
import { aggregatedOptionValue } from '../providerSettings/aggregatedOptions.js'

const TIER_ENV_KEYS = [
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
] as const

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = Object.fromEntries(TIER_ENV_KEYS.map(k => [k, process.env[k]]))
  for (const key of TIER_ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('settings editing on an aggregated row', () => {
  test('requires switching to the target profile first', () => {
    expect(canEditSettingsForOption(aggregatedOptionValue('gpt-5.4'))).toBe(
      false,
    )
    expect(canEditSettingsForOption('opus')).toBe(true)
    expect(canEditSettingsForOption('__NO_PREFERENCE__')).toBe(true)
  })
})

describe('resolveOptionModel on an aggregated row', () => {
  test('returns the id exactly as the owning provider serves it', () => {
    expect(resolveOptionModel(aggregatedOptionValue('glm-5.2'))).toBe('glm-5.2')
  })

  test('a qualified selector resolves to the bare id', () => {
    expect(resolveOptionModel(aggregatedOptionValue('gpt-5.4@relay'))).toBe(
      'gpt-5.4',
    )
  })

  test('an id containing "@" is unescaped, not split', () => {
    expect(
      resolveOptionModel(aggregatedOptionValue('text-bison@@002@vertex')),
    ).toBe('text-bison@002')
  })

  test('an id that spells a tier alias stays that provider’s id', () => {
    // Without the namespace this row would resolve through the alias table to
    // Anthropic's Opus checkpoint — a model this relay does not serve.
    const resolved = resolveOptionModel(aggregatedOptionValue('opus'))
    expect(resolved).toBe('opus')
    expect(resolved).not.toContain('claude')
  })
})

describe('settingsSlotForOption on an aggregated row', () => {
  test('an unpinned third-party id owns no settings slot', () => {
    expect(
      settingsSlotForOption(aggregatedOptionValue('glm-5.2')),
    ).toBeUndefined()
  })

  test('a pinned id still edits the slot it is pinned to', () => {
    // The reverse lookup is the ONLY thing that may claim a slot for these
    // rows: the user said this id is their opus, so effort written while it is
    // highlighted belongs to opus.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
    expect(settingsSlotForOption(aggregatedOptionValue('glm-5.2'))).toBe('opus')
  })

  test('a qualified selector resolves the slot from the id, not the profile', () => {
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-5.4'
    expect(settingsSlotForOption(aggregatedOptionValue('gpt-5.4@relay'))).toBe(
      'sonnet',
    )
    // The profile name is not a model id and must never reach the lookup.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'relay'
    expect(settingsSlotForOption(aggregatedOptionValue('gpt-5.4@relay'))).toBe(
      'sonnet',
    )
  })

  test('a row whose id merely looks like an alias is treated by name only', () => {
    // getModelTier sniffs the id, which is the same rule every other concrete
    // id in the picker gets. What must NOT happen is the value being read as a
    // SELECTION of the alias, which would apply even with the pin cleared.
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'something-else'
    expect(
      settingsSlotForOption(aggregatedOptionValue('kimi-k3')),
    ).toBeUndefined()
  })

  test('the provider default row is untouched by any of this', () => {
    expect(settingsSlotForOption('__NO_PREFERENCE__')).toBe('default')
    expect(settingsSlotForOption(undefined)).toBeUndefined()
  })
})
