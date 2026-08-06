/**
 * Tests for reopening the model step from the environment (`/models`).
 *
 * The rule worth pinning is which sessions have something to configure at all,
 * and that reopening prefills from the same env keys the wizard writes — a
 * mismatch there would silently clear a tier the moment the user saves.
 *
 * `currentProviderSetupKind` reads getAPIProvider(), which consults the real
 * settings.json through getInitialSettings(). Every case here therefore drives
 * the provider through CLAUDE_CODE_USE_* env vars and asserts nothing that
 * depends on settings.modelType being unset — see the note in
 * session/__tests__/contextWindowOverride.test.ts for why mocking settings
 * process-globally is not an option.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let fromEnv: typeof import('../fromEnvironment.js')

beforeAll(async () => {
  fromEnv = await import('../fromEnvironment.js')
})

const TOUCHED = [
  'CLAUDE_CODE_USE_OPENAI',
  'CLAUDE_CODE_USE_GEMINI',
  'CLAUDE_CODE_USE_GROK',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'GROK_BASE_URL',
  'GROK_DEFAULT_SONNET_MODEL',
] as const

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key]
})

/** The env a China-preset login leaves behind. */
function deepseekEnv(): NodeJS.ProcessEnv {
  return {
    CLAUDE_CODE_USE_OPENAI: '1',
    OPENAI_BASE_URL: 'https://api.deepseek.com',
    OPENAI_API_KEY: 'sk-test',
    OPENAI_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
    OPENAI_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro',
    OPENAI_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro',
    OPENAI_DEFAULT_FABLE_MODEL: 'deepseek-v4-pro',
  } as NodeJS.ProcessEnv
}

describe('currentProviderSetupKind', () => {
  test('a China endpoint reads as the China preset, not plain OpenAI', () => {
    // Both are OpenAI-compatible; the base URL is the only thing that tells
    // them apart, and only the preset brings a curated model table.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(fromEnv.currentProviderSetupKind(deepseekEnv())).toBe('china')
  })

  test('a non-preset OpenAI endpoint reads as openai', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(
      fromEnv.currentProviderSetupKind({
        CLAUDE_CODE_USE_OPENAI: '1',
        OPENAI_BASE_URL: 'https://gw.example.com/v1',
      } as NodeJS.ProcessEnv),
    ).toBe('openai')
  })

  test('Gemini and Grok map to their own specs', () => {
    process.env.CLAUDE_CODE_USE_GEMINI = '1'
    expect(fromEnv.currentProviderSetupKind({} as NodeJS.ProcessEnv)).toBe(
      'gemini',
    )
    delete process.env.CLAUDE_CODE_USE_GEMINI
    process.env.CLAUDE_CODE_USE_GROK = '1'
    expect(fromEnv.currentProviderSetupKind({} as NodeJS.ProcessEnv)).toBe(
      'grok',
    )
  })
})

describe('buildModelStepFromEnvironment', () => {
  test('prefills every tier from the keys the wizard writes', () => {
    // The round trip is the contract: what the wizard saved must come back
    // selected, or reopening the setting would clear it on the next save.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const step = fromEnv.buildModelStepFromEnvironment(deepseekEnv())

    expect(step?.kind).toBe('china')
    expect(step?.haikuModel).toBe('deepseek-v4-flash')
    expect(step?.sonnetModel).toBe('deepseek-v4-pro')
    expect(step?.opusModel).toBe('deepseek-v4-pro')
    expect(step?.fableModel).toBe('deepseek-v4-pro')
    // Carried through untouched — reopening must not ask for them again.
    expect(step?.baseUrl).toBe('https://api.deepseek.com')
    expect(step?.apiKey).toBe('sk-test')
  })

  test('a China preset supplies its own catalog, no cached fetch needed', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const step = fromEnv.buildModelStepFromEnvironment(deepseekEnv())

    expect(step?.entryMode).toBe('catalog')
    const ids = step?.entryMode === 'catalog' ? step.models.map(m => m.id) : []
    expect(ids).toContain('deepseek-v4-pro')
    expect(ids).toContain('deepseek-v4-flash')
  })

  test('opens on the first tier when the provider has no default-model field', () => {
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    expect(
      fromEnv.buildModelStepFromEnvironment(deepseekEnv())?.activeField,
    ).toBe('haiku_model')
  })

  test('no cached catalog and no built-in table falls back to manual entry', () => {
    // Grok has no built-in table, and the background catalog refresh may simply
    // not have run yet for this endpoint. Not an error state.
    process.env.CLAUDE_CODE_USE_GROK = '1'
    const step = fromEnv.buildModelStepFromEnvironment({
      CLAUDE_CODE_USE_GROK: '1',
      GROK_BASE_URL: 'https://gw.nowhere.example/v1',
      GROK_DEFAULT_SONNET_MODEL: 'some-model',
    } as NodeJS.ProcessEnv)

    expect(step?.entryMode).toBe('manual')
    // The configured value survives the fallback.
    expect(step?.sonnetModel).toBe('some-model')
  })

  test("no cached catalog still offers occ's own table where one exists", () => {
    // Reopening the setting must not degrade to a blank text box just because
    // the background refresh has not visited this endpoint yet.
    process.env.CLAUDE_CODE_USE_OPENAI = '1'
    const step = fromEnv.buildModelStepFromEnvironment({
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'https://gw.nowhere.example/v1',
      OPENAI_DEFAULT_SONNET_MODEL: 'some-model',
    } as NodeJS.ProcessEnv)

    expect(step?.entryMode).toBe('catalog')
    // And the configured value is offered even though the table lacks it.
    expect(step?.sonnetModel).toBe('some-model')
  })
})
