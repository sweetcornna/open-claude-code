import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { setupSettingsMock } from '../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

/**
 * 2.34's `/model` picker had no `default` slot: the Default row resolved the
 * model first and wrote whichever TIER that id reverse-looked-up to. 2.35 reads
 * the provider default from its own slot, so without this migration those values
 * stay in settings.json, stay visible in `/model-settings`, and stop applying.
 */

let userSettings: SettingsJson = {}
let initialSettings: SettingsJson = { modelType: 'openai' }
const writes: SettingsJson[] = []

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : null,
    getInitialSettings: () => initialSettings,
    getSettings_DEPRECATED: () => initialSettings,
    updateSettingsForSource: (_source, patch) => {
      writes.push(patch as SettingsJson)
      return { error: null }
    },
  }),
)
afterAll(() => settingsMock.reset())

const { migrateDefaultTierSettingsToDefaultSlot } = await import(
  '../migrateDefaultTierSettingsToDefaultSlot.js'
)

const ENV = ['OPENAI_MODEL', 'OPENAI_DEFAULT_OPUS_MODEL'] as const
const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]))

afterEach(() => {
  writes.length = 0
  userSettings = {}
  initialSettings = { modelType: 'openai' }
  for (const key of ENV) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

test("copies the default model's tier settings into the default slot", () => {
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
  userSettings = {
    modelSettings: { opus: { effort: 'max', contextTokens: 512_000 } },
  } as SettingsJson

  migrateDefaultTierSettingsToDefaultSlot()

  expect(writes).toHaveLength(1)
  expect(writes[0]?.modelSettings?.default).toEqual({
    effort: 'max',
    contextTokens: 512_000,
  })
  // Copy, not move: an explicit `/model opus` still belongs to the tier slot.
  expect(writes[0]?.modelSettings?.opus).toEqual({
    effort: 'max',
    contextTokens: 512_000,
  })
})

test('does nothing once the default slot exists', () => {
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
  userSettings = {
    modelSettings: {
      default: { effort: 'low' },
      opus: { effort: 'max' },
    },
  } as SettingsJson

  migrateDefaultTierSettingsToDefaultSlot()

  expect(writes).toHaveLength(0)
})

test('does nothing when the default model has no tier settings', () => {
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
  userSettings = {
    modelSettings: { haiku: { effort: 'low' } },
  } as SettingsJson

  migrateDefaultTierSettingsToDefaultSlot()

  expect(writes).toHaveLength(0)
})

test('does nothing when modelSettings was never written', () => {
  migrateDefaultTierSettingsToDefaultSlot()
  expect(writes).toHaveLength(0)
})

test('is idempotent — a second run sees the slot it just wrote', () => {
  process.env.OPENAI_MODEL = 'glm-5.2'
  process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
  userSettings = {
    modelSettings: { opus: { effort: 'max' } },
  } as SettingsJson

  migrateDefaultTierSettingsToDefaultSlot()
  userSettings = writes[0] as SettingsJson
  migrateDefaultTierSettingsToDefaultSlot()

  expect(writes).toHaveLength(1)
})
