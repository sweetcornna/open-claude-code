/**
 * Tests for the step-1 → step-2 handoff.
 *
 * Only the decision is pinned, not the keystrokes: Ink's test mode does not
 * pump concurrent state updates, so multi-keystroke tests in this repo are
 * unreliable (see MigrationStep.test.tsx, WorkflowsPanel.test.tsx). The rule
 * worth pinning is which remembered values survive into step 2 — a model the
 * endpoint no longer serves must not stay selected, or the user saves a
 * configuration this server cannot answer for.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../../utils/settings/types.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

/**
 * The step-2 prefill reads settings.modelSettings for max context and effort.
 * Without a pinned source these assertions measure the developer's own
 * settings.json — a configured per-tier window outranks the legacy env key the
 * test is exercising, so it fails locally and passes on a bare CI runner.
 */
const settingsMock = setupSettingsMock()

let wizard: typeof import('../ProviderSetupWizard.js')
let specs: typeof import('../specs.js')

beforeAll(async () => {
  settingsMock.set({
    getSettingsForSource: () => ({}) as SettingsJson,
    getInitialSettings: () => ({}) as SettingsJson,
  })
  wizard = await import('../ProviderSetupWizard.js')
  specs = await import('../specs.js')
})

afterAll(() => settingsMock.reset())

const TOUCHED_ENV = [
  'OPENAI_MODEL',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
] as const

afterEach(() => {
  for (const key of TOUCHED_ENV) delete process.env[key]
})

function endpointStatus(): import('../state.js').ProviderEndpointSetupStatus {
  return {
    state: 'provider_endpoint_setup',
    kind: 'openai',
    phase: 'fetching',
    baseUrl: 'https://gw.example.com/v1',
    apiKey: 'sk-test',
    wireApi: 'responses',
    activeField: 'api_key',
  }
}

describe('buildModelStep', () => {
  test('a failed fetch lands in manual entry, carrying the reason', () => {
    // Grok: no built-in table, so there is nothing to fall back to.
    const step = wizard.buildModelStep(
      { ...endpointStatus(), kind: 'grok' },
      specs.PROVIDER_SETUP_SPECS.grok,
      null,
      'the /models endpoint was not found (HTTP 404)',
    )

    expect(step.entryMode).toBe('manual')
    expect(step.entryMode === 'manual' && step.fetchError).toBe(
      'the /models endpoint was not found (HTTP 404)',
    )
    // The endpoint the user just typed survives — the whole point of falling
    // back rather than erroring is that this configuration can still be saved.
    expect(step.baseUrl).toBe('https://gw.example.com/v1')
    expect(step.apiKey).toBe('sk-test')
    expect(step.wireApi).toBe('responses')
  })

  test('manual entry keeps every remembered value — there is nothing to check it against', () => {
    process.env.GROK_MODEL = 'retired-model'
    process.env.GROK_DEFAULT_OPUS_MODEL = 'also-retired'

    const step = wizard.buildModelStep(
      { ...endpointStatus(), kind: 'grok' },
      specs.PROVIDER_SETUP_SPECS.grok,
      null,
      'the request failed',
    )

    expect(step.model).toBe('retired-model')
    expect(step.opusModel).toBe('also-retired')
    delete process.env.GROK_MODEL
    delete process.env.GROK_DEFAULT_OPUS_MODEL
  })

  test("a failed fetch falls back to occ's own table where one exists", () => {
    // Better than a blank text box: the endpoint may be fine and simply not
    // implement /models. The note tells the user these are occ's guesses.
    const step = wizard.buildModelStep(
      endpointStatus(),
      specs.PROVIDER_SETUP_SPECS.openai,
      null,
      'the /models endpoint was not found (HTTP 404)',
    )

    expect(step.entryMode).toBe('catalog')
    if (step.entryMode !== 'catalog') return
    expect(step.models.length).toBeGreaterThan(0)
    expect(step.catalogNote).toContain('HTTP 404')
  })

  test("the endpoint's answer is merged with occ's table, endpoint first", () => {
    const step = wizard.buildModelStep(
      endpointStatus(),
      specs.PROVIDER_SETUP_SPECS.openai,
      [{ id: 'house-blend-1' }],
      '',
    )

    expect(step.entryMode).toBe('catalog')
    if (step.entryMode !== 'catalog') return
    expect(step.models[0]?.id).toBe('house-blend-1')
    expect(step.models.map(m => m.id)).toContain('gpt-5.6-sol')
    // A merged fallback is not a failure — no note.
    expect(step.catalogNote).toBeUndefined()
  })

  test('catalog entry seeds the current configuration as the selection', () => {
    process.env.OPENAI_MODEL = 'gpt-5.5'
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'gpt-5.4-mini'
    process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '128000'

    const step = wizard.buildModelStep(
      endpointStatus(),
      specs.PROVIDER_SETUP_SPECS.openai,
      [{ id: 'gpt-5.5' }, { id: 'gpt-5.4-mini' }],
      '',
    )

    expect(step.entryMode).toBe('catalog')
    expect(step.model).toBe('gpt-5.5')
    expect(step.haikuModel).toBe('gpt-5.4-mini')
    expect(step.maxContext).toBe('128000')
    expect(step.activeField).toBe('model')
  })

  test('a remembered model the endpoint no longer serves is dropped', () => {
    // Leaving it selected would let the user save a model this server cannot
    // answer for — the failure would surface later as a request error.
    process.env.OPENAI_MODEL = 'gpt-4o'
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'gpt-4o-mini'
    process.env.OPENAI_DEFAULT_FABLE_MODEL = 'gpt-5.5'

    const step = wizard.buildModelStep(
      endpointStatus(),
      specs.PROVIDER_SETUP_SPECS.openai,
      [{ id: 'gpt-5.5' }],
      '',
    )

    expect(step.model).toBe('')
    expect(step.sonnetModel).toBe('')
    // Still served, so still selected.
    expect(step.fableModel).toBe('gpt-5.5')
  })

  test('each provider is seeded from its own env keys', () => {
    process.env.OPENAI_MODEL = 'gpt-5.5'
    // Gemini reads GEMINI_MODEL; it must not pick up the OpenAI one.
    const step = wizard.buildModelStep(
      { ...endpointStatus(), kind: 'gemini' },
      specs.PROVIDER_SETUP_SPECS.gemini,
      null,
      'no API key was provided, so the model list could not be requested',
    )
    expect(step.model).toBe('')
  })
})
