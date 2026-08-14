import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../utils/settings/types.js'

/**
 * The max-context cycler in `/model` (Space on the highlighted row).
 *
 * Split from modelPickerOptions.test.ts, which documents that it deliberately
 * uses no mocks: the ladder reads a saved per-tier override, so it needs the
 * settings source mocked or it would measure the developer's own settings.json.
 */

let userSettings: SettingsJson = {}
let initialSettings: SettingsJson = { modelType: 'anthropic' }

const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? userSettings : null,
    getInitialSettings: () => initialSettings,
    getSettings_DEPRECATED: () => initialSettings,
  }),
)
afterAll(() => settingsMock.reset())

const { nextContextChoice } = await import('../ModelPicker.js')

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'CLAUDE_CODE_DISABLE_1M_CONTEXT',
] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]))

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  userSettings = {}
  initialSettings = { modelType: 'anthropic' }
  for (const key of ENV_KEYS) delete process.env[key]
})

afterAll(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('max-context cycler', () => {
  test('a saved window the model cannot serve steps DOWN to the nearest served one', () => {
    // The 372k a real machine was found carrying. It is no longer a rung on a
    // bare Claude id (nothing between 200k and 1M is served), and restarting at
    // the bottom of the ladder would trade an unusable window for a needlessly
    // small one — 200k is right there and fully served.
    userSettings = {
      modelSettings: { opus: { contextTokens: 372_000 } },
    } as SettingsJson

    expect(nextContextChoice('claude-opus-5', undefined, 'opus')).toBe(200_000)
    expect(nextContextChoice('claude-opus-5', 372_000, 'opus')).toBe(200_000)
  })

  test('the ladder still walks up and clears past the top', () => {
    userSettings = {} as SettingsJson

    expect(nextContextChoice('claude-opus-5', 128_000, 'opus')).toBe(200_000)
    // 272k and 512k are not offered on a bare Claude id, so 200k's next rung is
    // the 1M opt-in.
    expect(nextContextChoice('claude-opus-5', 200_000, 'opus')).toBe(1_000_000)
    // Past the top rung is "back to the tier default".
    expect(nextContextChoice('claude-opus-5', 1_000_000, 'opus')).toBeNull()
  })

  test('the [1m] opt-in keeps every rung, including the band', () => {
    userSettings = {
      modelSettings: { opus: { contextTokens: 372_000 } },
    } as SettingsJson

    // A sub-1M budget on a 1M model is a valid choice, so 372k stays a rung and
    // the cycler moves UP from it rather than correcting it.
    expect(nextContextChoice('claude-opus-5[1m]', undefined, 'opus')).toBe(
      512_000,
    )
    expect(nextContextChoice('claude-opus-5[1m]', 272_000, 'opus')).toBe(
      372_000,
    )
  })

  test('below every rung, the bottom is the only move', () => {
    userSettings = {
      modelSettings: { opus: { contextTokens: 64_000 } },
    } as SettingsJson

    // A saved value joins the rung set, so 64k is one and the ladder walks up
    // from it as usual.
    expect(nextContextChoice('claude-opus-5', undefined, 'opus')).toBe(128_000)
    // A current value that is neither saved nor on the ladder and sits below
    // every rung has nothing to step down to, so the bottom is the move.
    expect(nextContextChoice('claude-opus-5', 32_000, 'opus')).toBe(64_000)
  })

  test('a third-party id keeps the whole ladder', () => {
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'glm-5.2'
    initialSettings = { modelType: 'openai' }
    userSettings = {
      modelSettings: { opus: { contextTokens: 372_000 } },
    } as SettingsJson

    // Nothing is filtered out, so 372k is a rung and the next one is above it.
    expect(nextContextChoice('glm-5.2', 272_000, 'opus')).toBe(372_000)
    expect(nextContextChoice('glm-5.2', 372_000, 'opus')).toBe(512_000)
  })
})
