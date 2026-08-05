import { afterAll, describe, expect, test } from 'bun:test'
import * as realModel from 'src/utils/model/model.js'
import * as realProviders from 'src/utils/model/providers.js'
import type { APIProvider } from 'src/utils/model/providers.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'

// The gate reads global session state, so the test drives it by replacing the
// two getters it calls. Complete-surface delegating mocks: every other export
// of these very widely imported modules keeps its real implementation.
const providersMock = makeSharedModuleMock(
  'src/utils/model/providers.js',
  realProviders,
).setup()
const modelMock = makeSharedModuleMock(
  'src/utils/model/model.js',
  realModel,
).setup()

const { isGptTuningActive, isGptTuningActiveForModel } = await import(
  'src/utils/model/gptTuning.js'
)
const { isGptFamilyModel } = await import('src/utils/model/chatgptModels.js')

function session(provider: APIProvider, mainLoopModel: string): void {
  providersMock.set({ getAPIProvider: () => provider })
  modelMock.set({ getMainLoopModel: () => mainLoopModel })
}

afterAll(() => {
  providersMock.reset()
  modelMock.reset()
})

describe('isGptTuningActive', () => {
  test('is on for a GPT model on the openai provider', () => {
    session('openai', 'gpt-5.6-sol')
    expect(isGptTuningActive()).toBe(true)
  })

  test('resolves Claude aliases through the OpenAI model mapping', () => {
    // `/model opus` on the openai provider maps to gpt-5.6-sol at request
    // time; the gate must apply the same mapping.
    session('openai', 'claude-opus-4-7')
    expect(isGptTuningActive()).toBe(true)
  })

  test('is off for a non-GPT model behind the openai-compatible layer', () => {
    session('openai', 'deepseek-chat')
    expect(isGptTuningActive()).toBe(false)
  })

  test('is off on first-party Anthropic sessions regardless of model', () => {
    session('firstParty', 'claude-sonnet-4-6')
    expect(isGptTuningActive()).toBe(false)
    session('firstParty', 'gpt-5.6-sol')
    expect(isGptTuningActive()).toBe(false)
  })

  test('is off for other third-party providers', () => {
    session('gemini', 'gemini-3-pro')
    expect(isGptTuningActive()).toBe(false)
    session('bedrock', 'claude-sonnet-4-6')
    expect(isGptTuningActive()).toBe(false)
  })
})

describe('isGptTuningActiveForModel', () => {
  test('judges the passed model, not the main-loop model', () => {
    session('openai', 'deepseek-chat')
    expect(isGptTuningActiveForModel('gpt-5.6-luna')).toBe(true)
    session('openai', 'gpt-5.6-sol')
    expect(isGptTuningActiveForModel('deepseek-chat')).toBe(false)
  })

  test('still requires the openai provider', () => {
    session('firstParty', 'claude-sonnet-4-6')
    expect(isGptTuningActiveForModel('gpt-4o')).toBe(false)
  })
})

describe('isGptFamilyModel', () => {
  test('matches GPT and Codex lineage ids across generations', () => {
    expect(isGptFamilyModel('gpt-4o')).toBe(true)
    expect(isGptFamilyModel('gpt-5.6-terra[1m]')).toBe(true)
    expect(isGptFamilyModel('codex-mini-latest')).toBe(true)
  })

  test('does not match non-GPT models served over the same wire format', () => {
    expect(isGptFamilyModel('deepseek-v3')).toBe(false)
    expect(isGptFamilyModel('claude-sonnet-4-6')).toBe(false)
  })
})
