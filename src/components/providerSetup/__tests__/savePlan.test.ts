/**
 * What a wizard save decides.
 *
 * These are the rules that used to live inside a React event handler, where
 * the only way to exercise them was to render a form and drive a picker — so
 * in practice they were never exercised at all, and three of them were wrong:
 * a blank credential field deleted a subscription login, clearing the other
 * provider groups reached into `process.env` and took keys occ never set, and
 * "(model default)" did nothing in the one case where someone would choose it.
 *
 * Only the log/debug leaves are mock.module'd (shared mocks, per CLAUDE.md).
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

let savePlan: typeof import('../savePlan.js')
let specs: typeof import('../specs.js')

beforeAll(async () => {
  savePlan = await import('../savePlan.js')
  specs = await import('../specs.js')
})

type Values = import('../specs.js').ProviderSetupValues
type ModelStatus = import('../state.js').ProviderModelSetupStatus

function values(overrides: Partial<Values> = {}): Values {
  return {
    model: '',
    haiku_model: '',
    sonnet_model: '',
    opus_model: '',
    fable_model: '',
    maxContext: '',
    effort: '',
    ...overrides,
  }
}

function status(overrides: Partial<ModelStatus> = {}): ModelStatus {
  return {
    state: 'provider_model_setup',
    kind: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: '',
    maxContext: '',
    effort: '',
    haikuModel: '',
    sonnetModel: '',
    opusModel: '',
    fableModel: '',
    activeField: 'model',
    entryMode: 'manual',
    fetchError: 'not requested',
    ...overrides,
  } as ModelStatus
}

/** The spec the wizard would use for a session on this auth mode. */
function specFor(
  kind: import('../specs.js').ProviderSetupKind,
  env: NodeJS.ProcessEnv = {},
): import('../specs.js').ProviderSetupSpec {
  const spec = specs.PROVIDER_SETUP_SPECS[kind]
  return specs.specForSubscriptionAuth(
    spec,
    specs.activeSubscriptionAuth(spec, env),
  )
}

function plan(
  overrides: Partial<import('../savePlan.js').ProviderSaveInput> & {
    spec: import('../specs.js').ProviderSetupSpec
  },
): import('../savePlan.js').ProviderSavePlan {
  return savePlan.planProviderSave({
    status: status(),
    values: values(),
    contextTokens: undefined,
    effortTouched: false,
    existingSettings: undefined,
    processEnv: {},
    ...overrides,
  })
}

describe('a subscription session edits models only', () => {
  const chatgptEnv = { OPENAI_AUTH_MODE: 'chatgpt' } as NodeJS.ProcessEnv

  test('nothing on the ChatGPT credential plane is written', () => {
    // The whole bug: OPENAI_API_KEY is empty for a ChatGPT session, so "empty
    // means delete" deleted it; extraEnv then cleared OPENAI_AUTH_MODE and
    // afterSave deleted the stored tokens. Three writes, one dead session, for
    // a user who came here to repoint a tier.
    const result = plan({
      spec: specFor('openai', chatgptEnv),
      status: status({ credentialEditing: 'locked', sonnetModel: 'gpt-5.5' }),
      values: values({ sonnet_model: 'gpt-5.5' }),
      existingSettings: { modelType: 'openai' },
      processEnv: chatgptEnv,
    })

    for (const key of [
      'OPENAI_AUTH_MODE',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_WIRE_API',
    ]) {
      expect(Object.keys(result.env)).not.toContain(key)
    }
    expect(result.credentialsConfigured).toBe(false)
    // The part the user actually asked for still happens.
    expect(result.env.OPENAI_DEFAULT_SONNET_MODEL).toBe('gpt-5.5')
  })

  test('Antigravity keeps its Google sign-in for the same reason', () => {
    const antigravityEnv = {
      GEMINI_AUTH_MODE: 'antigravity',
    } as NodeJS.ProcessEnv
    const result = plan({
      spec: specFor('gemini', antigravityEnv),
      status: status({
        kind: 'gemini',
        baseUrl: '',
        credentialEditing: 'locked',
        opusModel: 'gemini-pro-agent',
      }),
      values: values({ opus_model: 'gemini-pro-agent' }),
      existingSettings: { modelType: 'gemini' },
      processEnv: antigravityEnv,
    })

    for (const key of [
      'GEMINI_AUTH_MODE',
      'GEMINI_API_KEY',
      'GEMINI_BASE_URL',
    ]) {
      expect(Object.keys(result.env)).not.toContain(key)
    }
    expect(result.credentialsConfigured).toBe(false)
    expect(result.env.GEMINI_DEFAULT_OPUS_MODEL).toBe('gemini-pro-agent')
  })

  test('a ChatGPT session no longer has to invent a default model', () => {
    // OPENAI_MODEL pins ONE model for every alias, which is the opposite of
    // what someone opening the tier form wants; the Codex backend maps tiers
    // on its own, so the spec override drops the requirement.
    expect(specFor('openai', chatgptEnv).validate(values())).toBeNull()
    expect(specFor('openai').validate(values())?.field).toBe('model')
  })

  test('the same provider reached from /login still replaces its credentials', () => {
    // No lock: the user picked "OpenAI Chat Completions" from the login menu,
    // which is exactly the request to leave the subscription behind.
    const result = plan({
      spec: specFor('openai', chatgptEnv),
      status: status({ apiKey: 'sk-typed', wireApi: 'responses' }),
      values: values({ model: 'gpt-5.5' }),
      processEnv: chatgptEnv,
    })

    expect(result.credentialsConfigured).toBe(true)
    expect(result.env.OPENAI_API_KEY).toBe('sk-typed')
    expect(Object.keys(result.env)).toContain('OPENAI_AUTH_MODE')
    expect(result.env.OPENAI_AUTH_MODE).toBeUndefined()
    expect(result.env.OPENAI_WIRE_API).toBe('responses')
  })

  test('an OpenCode subscription save still writes identity and endpoint', () => {
    // The asymmetry ChatGPT and Antigravity hide: for them the endpoint really
    // is credential-plane, so skipping it costs nothing. OpenCode's selects the
    // PRODUCT — Zen or Go — which the user chose in the login menu, and
    // OPENCODE_AUTH_MODE is the sole basis of isOpencodeSessionActive(). Left
    // out, the session reports itself as OpenCode while applyOpencodeWire()
    // returns early and mirrors nothing: a routing it claims but never applied.
    const opencodeEnv = { OPENCODE_AUTH_MODE: 'opencode' } as NodeJS.ProcessEnv
    const result = plan({
      spec: specFor('opencode', opencodeEnv),
      status: status({
        kind: 'opencode',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        credentialEditing: 'locked',
        model: 'deepseek-v4-flash',
      }),
      values: values({ model: 'deepseek-v4-flash' }),
      existingSettings: { modelType: 'opencode' },
      processEnv: opencodeEnv,
    })

    expect(result.credentialsConfigured).toBe(false)
    expect(result.env.OPENCODE_AUTH_MODE).toBe('opencode')
    expect(result.env.OPENCODE_BASE_URL).toBe('https://opencode.ai/zen/go/v1')
    expect(result.env.OPENCODE_MODEL).toBe('deepseek-v4-flash')
    // Still model-only where it counts: the credential is a 0600 access token
    // that must never reach settings.env.
    expect(result.env.OPENCODE_API_KEY).toBeUndefined()
  })

  test('switching OpenCode product counts as a provider change', () => {
    // Reachable only because sessionEnv puts the endpoint in `env` for a
    // model-only save too; before that this comparison was gated on
    // credentialsConfigured and a Zen→Go move was reported as no change,
    // leaving an in-session /model choice pointed at the other product's bill.
    const opencodeEnv = {
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: 'https://opencode.ai/zen/v1',
      OPENCODE_MODEL: 'kimi-k3',
    } as NodeJS.ProcessEnv
    const result = plan({
      spec: specFor('opencode', opencodeEnv),
      status: status({
        kind: 'opencode',
        baseUrl: 'https://opencode.ai/zen/go/v1',
        credentialEditing: 'locked',
        model: 'kimi-k3',
      }),
      values: values({ model: 'kimi-k3' }),
      existingSettings: { modelType: 'opencode' },
      processEnv: opencodeEnv,
    })

    expect(result.outcome.providerChanged).toBe(true)
  })
})

describe('clearing the other provider groups', () => {
  test('rewrites settings for every group but this one', () => {
    const result = plan({
      spec: specFor('gemini'),
      status: status({ kind: 'gemini', baseUrl: '', apiKey: 'k' }),
      values: values({ model: 'gemini-3-pro' }),
    })

    expect(result.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(Object.keys(result.env)).toContain('ANTHROPIC_API_KEY')
    expect(Object.keys(result.env)).toContain('OPENAI_API_KEY')
    expect(Object.keys(result.env)).toContain('GROK_API_KEY')
    // Its own group is untouched by the sweep — the fields below fill it in.
    expect(result.env.GEMINI_API_KEY).toBe('k')
  })
})

describe('applyProviderSaveEnv', () => {
  test('a key the user exported in their own shell survives', () => {
    // occ hands the whole environment to every Bash tool call, so deleting
    // this would break the user's own scripts for the rest of the session —
    // over a key occ never set and cannot restore.
    const processEnv = {
      ANTHROPIC_API_KEY: 'sk-from-shell',
    } as NodeJS.ProcessEnv
    savePlan.applyProviderSaveEnv(
      { ANTHROPIC_API_KEY: undefined },
      {},
      processEnv,
    )
    expect(processEnv.ANTHROPIC_API_KEY).toBe('sk-from-shell')
  })

  test('a key occ itself put there is removed', () => {
    const processEnv = { ANTHROPIC_API_KEY: 'sk-managed' } as NodeJS.ProcessEnv
    savePlan.applyProviderSaveEnv(
      { ANTHROPIC_API_KEY: undefined },
      { ANTHROPIC_API_KEY: 'sk-managed' },
      processEnv,
    )
    expect(Object.keys(processEnv)).not.toContain('ANTHROPIC_API_KEY')
  })

  test('a managed key the user has since overridden counts as theirs', () => {
    const processEnv = {
      ANTHROPIC_BASE_URL: 'https://mine.example',
    } as NodeJS.ProcessEnv
    savePlan.applyProviderSaveEnv(
      { ANTHROPIC_BASE_URL: undefined },
      { ANTHROPIC_BASE_URL: 'https://settings.example' },
      processEnv,
    )
    expect(processEnv.ANTHROPIC_BASE_URL).toBe('https://mine.example')
  })

  test('writing is unconditional — the user just asked for it', () => {
    const processEnv = { OPENAI_API_KEY: 'sk-old' } as NodeJS.ProcessEnv
    savePlan.applyProviderSaveEnv({ OPENAI_API_KEY: 'sk-new' }, {}, processEnv)
    expect(processEnv.OPENAI_API_KEY).toBe('sk-new')
  })
})

describe('resetting thinking effort', () => {
  // Two tiers configured differently, which is why the form prefills empty.
  const mixed = {
    haiku: { effort: 'low' as const, contextTokens: 200_000 },
    opus: { effort: 'max' as const, contextTokens: 1_000_000 },
  }

  const tierValues = values({
    model: 'gpt-5.5',
    haiku_model: 'gpt-5.4-mini',
    opus_model: 'gpt-5.5',
  })

  test('choosing (model default) clears every slot even when the prefill was already empty', () => {
    // The prefill is empty because the tiers DISAGREE — which is exactly the
    // state someone opens the form to fix. Inferring "the user changed
    // nothing" from it meant the fix was unreachable.
    const result = plan({
      spec: specFor('openai'),
      status: status({ apiKey: 'k', effort: '' }),
      values: tierValues,
      effortTouched: true,
      existingSettings: { modelType: 'openai', modelSettings: mixed },
    })

    for (const slot of ['haiku', 'opus'] as const) {
      expect(Object.keys(result.modelSettings[slot] ?? {})).toContain('effort')
      expect(result.modelSettings[slot]?.effort).toBeUndefined()
    }
  })

  test('walking past the field changes nothing', () => {
    const result = plan({
      spec: specFor('openai'),
      status: status({ apiKey: 'k', effort: '' }),
      values: tierValues,
      effortTouched: false,
      existingSettings: { modelType: 'openai', modelSettings: mixed },
    })
    expect(result.modelSettings).toEqual({})
  })

  test('a saved value the user cleared still resets without the picker', () => {
    // The old route in, kept: the prefill agreed on a value and the form came
    // back empty, so something cleared it.
    const result = plan({
      spec: specFor('openai'),
      status: status({ apiKey: 'k', effort: 'max' }),
      values: tierValues,
      effortTouched: false,
      existingSettings: { modelType: 'openai', modelSettings: mixed },
    })
    expect(Object.keys(result.modelSettings.opus ?? {})).toContain('effort')
    expect(result.modelSettings.opus?.effort).toBeUndefined()
  })

  test('a first setup seeds family defaults instead — there is nothing to clear', () => {
    const result = plan({
      spec: specFor('openai'),
      status: status({ apiKey: 'k', effort: '' }),
      values: tierValues,
      effortTouched: true,
      existingSettings: { modelType: 'openai' },
    })
    expect(result.modelSettings.opus?.effort).toBeDefined()
  })
})

describe('whether the session’s model selection survives', () => {
  const openaiEnv = {
    OPENAI_BASE_URL: 'https://api.openai.com/v1',
    OPENAI_MODEL: 'gpt-5.5',
  } as NodeJS.ProcessEnv

  function outcomeFor(
    overrides: Partial<import('../savePlan.js').ProviderSaveInput> = {},
  ): import('../savePlan.js').ProviderSaveOutcome {
    return plan({
      spec: specFor('openai'),
      status: status({ apiKey: 'k', model: 'gpt-5.5' }),
      values: values({ model: 'gpt-5.5' }),
      existingSettings: { modelType: 'openai' },
      processEnv: openaiEnv,
      ...overrides,
    }).outcome
  }

  test('an effort-only edit keeps it — a tier alias re-resolves anyway', () => {
    expect(outcomeFor({ effortTouched: true }).providerChanged).toBe(false)
  })

  test('repointing a tier keeps it too', () => {
    expect(
      outcomeFor({
        values: values({ model: 'gpt-5.5', haiku_model: 'gpt-5.4-mini' }),
      }).providerChanged,
    ).toBe(false)
  })

  test('a different default model drops it', () => {
    expect(
      outcomeFor({ values: values({ model: 'gpt-5.4' }) }).providerChanged,
    ).toBe(true)
  })

  test('a different endpoint drops it', () => {
    expect(
      outcomeFor({
        status: status({
          apiKey: 'k',
          model: 'gpt-5.5',
          baseUrl: 'https://gw.example/v1',
        }),
      }).providerChanged,
    ).toBe(true)
  })

  test('a different provider drops it', () => {
    expect(
      outcomeFor({ existingSettings: { modelType: 'gemini' } }).providerChanged,
    ).toBe(true)
  })

  test('the outcome names the provider that was written', () => {
    expect(outcomeFor().modelType).toBe('openai')
  })
})
