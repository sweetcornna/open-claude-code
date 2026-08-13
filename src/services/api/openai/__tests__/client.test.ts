import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyProviderSaveEnv,
  planProviderSave,
} from '../../../../components/providerSetup/savePlan.js'
import { PROVIDER_SETUP_SPECS } from '../../../../components/providerSetup/specs.js'
import { resetOpencodeCredentialCache } from '../../opencodeCredential.js'
import { clearOpenAIClientCache, getOpenAIClient } from '../client.js'

const savedEnv: Record<string, string | undefined> = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_WIRE_API: process.env.OPENAI_WIRE_API,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENCODE_AUTH_MODE: process.env.OPENCODE_AUTH_MODE,
  OPENCODE_BASE_URL: process.env.OPENCODE_BASE_URL,
  OPENCODE_MODEL: process.env.OPENCODE_MODEL,
  OPENCODE_API_KEY: process.env.OPENCODE_API_KEY,
}

afterEach(() => {
  clearOpenAIClientCache()
  // Before the env restore: the mirror only releases a key that still holds the
  // value it wrote, so restoring first would leave its claim ledger vouching
  // for this file's values in every later file of the shard.
  resetOpencodeCredentialCache()
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('getOpenAIClient cache', () => {
  test('includes maxRetries in the cache key', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'

    const noRetries = getOpenAIClient({ maxRetries: 0 })
    const twoRetries = getOpenAIClient({ maxRetries: 2 })
    const twoRetriesAgain = getOpenAIClient({ maxRetries: 2 })
    const clampedRetries = getOpenAIClient({ maxRetries: 999 })

    expect(noRetries).not.toBe(twoRetries)
    expect(twoRetriesAgain).toBe(twoRetries)
    expect(noRetries.maxRetries).toBe(0)
    expect(twoRetries.maxRetries).toBe(2)
    expect(clampedRetries.maxRetries).toBe(15)
  })

  test('turns a trailing-slash origin into a versioned SDK base', async () => {
    const seen: {
      url: string
      authorization: string | null
      model: unknown
    }[] = []
    // Build the same patch the model step saves, then replay it before the
    // client is built. Credentials must survive and the selected model must pass
    // through unchanged to the request body.
    const plan = planProviderSave({
      spec: PROVIDER_SETUP_SPECS.openai,
      status: {
        state: 'provider_model_setup',
        kind: 'openai',
        baseUrl: 'https://gateway.example/',
        apiKey: 'sk-test',
        wireApi: 'chat',
        model: '',
        maxContext: '',
        effort: '',
        haikuModel: '',
        sonnetModel: '',
        opusModel: '',
        fableModel: '',
        activeField: 'model',
        entryMode: 'catalog',
        models: [{ id: 'house-model' }],
      },
      values: {
        model: 'house-model',
        maxContext: '',
        effort: '',
        haiku_model: '',
        sonnet_model: '',
        opus_model: '',
        fable_model: '',
      },
      contextTokens: undefined,
      effortTouched: false,
      existingSettings: undefined,
      processEnv: {},
    })
    applyProviderSaveEnv(plan.env, undefined, process.env)
    expect(plan.env.OPENAI_API_KEY).toBe('sk-test')
    expect(plan.env.OPENAI_MODEL).toBe('house-model')
    expect(plan.env.OPENAI_WIRE_API).toBe('chat')
    const client = getOpenAIClient({
      fetchOverride: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        seen.push({
          url: String(input),
          authorization: new Headers(init?.headers).get('authorization'),
          model: body.model,
        })
        return new Response(
          [
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'house-model',
              choices: [
                {
                  index: 0,
                  delta: { role: 'assistant', content: 'OK' },
                  finish_reason: null,
                },
              ],
            })}`,
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'house-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch,
    })

    let content = ''
    const stream = await client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 8,
      stream: true,
    })
    for await (const chunk of stream) {
      content += chunk.choices[0]?.delta.content ?? ''
    }

    expect(client.baseURL).toBe('https://gateway.example/v1')
    expect(seen).toEqual([
      {
        url: 'https://gateway.example/v1/chat/completions',
        authorization: 'Bearer sk-test',
        model: 'house-model',
      },
    ])
    expect(content).toBe('OK')
  })

  test('keeps an explicit root Chat Completions resource on the root route', async () => {
    const seen: string[] = []
    const client = getOpenAIClient({
      apiKeyOverride: 'sk-test',
      baseURLOverride: 'https://gateway.example/chat/completions',
      fetchOverride: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(
          [
            `data: ${JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion.chunk',
              created: 1,
              model: 'house-model',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}`,
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }) as unknown as typeof fetch,
    })

    const stream = await client.chat.completions.create({
      model: 'house-model',
      messages: [{ role: 'user', content: 'Hi' }],
      stream: true,
    })
    for await (const _chunk of stream) {
      // Drain the request; only the URL is under test.
    }

    expect(client.baseURL).toBe('https://gateway.example')
    expect(seen).toEqual(['https://gateway.example/chat/completions'])
  })

  test('splits resource URLs and query params before SDK requests', async () => {
    const seen: string[] = []
    const client = getOpenAIClient({
      apiKeyOverride: 'sk-test',
      baseURLOverride:
        'https://gateway.example/Tenant/v1/chat/completions?api-version=AbC#wrong',
      fetchOverride: (async (input: RequestInfo | URL) => {
        seen.push(String(input))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.models.list()
    expect(client.baseURL).toBe('https://gateway.example/Tenant/v1')
    expect(seen).toEqual([
      'https://gateway.example/Tenant/v1/models?api-version=AbC',
    ])
  })
})

describe('an OpenCode session', () => {
  const ZEN = 'https://opencode.ai/zen/v1'

  function zenSession(): void {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_BASE_URL = ZEN
    process.env.OPENCODE_MODEL = 'gpt-5.6-codex'
    process.env.OPENCODE_API_KEY = 'zen-key'
    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
  }

  test('mirrors OPENCODE_* onto the OPENAI_* keys at construction', () => {
    // Not at the call sites. Every path that mutates provider env would
    // otherwise have to remember to re-run the mirror, and the DeepSeek lane
    // already proved that is whack-a-mole — the ones that forgot sent requests
    // to the wrong host with no credential.
    zenSession()

    const client = getOpenAIClient({ maxRetries: 0 })

    expect(process.env.OPENAI_BASE_URL).toBe(ZEN)
    expect(process.env.OPENAI_WIRE_API).toBe('responses')
    expect(client.baseURL).toBe(ZEN)
  })

  test('carries a live credential on the request, not one baked in at build', async () => {
    // The client is cached for the life of the process while an OpenCode OAuth
    // token lapses in about an hour, so a key captured at construction is a 401
    // by the second hour of a session — and on the very first request of a
    // fresh login there is no key to capture yet at all.
    zenSession()
    const seen: (string | null)[] = []

    const client = getOpenAIClient({
      maxRetries: 0,
      fetchOverride: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.models.list()
    expect(seen).toEqual(['Bearer zen-key'])
  })

  test('leaves every other endpoint on the fetch it had', async () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    const seen: (string | null)[] = []

    const client = getOpenAIClient({
      maxRetries: 0,
      fetchOverride: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(new Headers(init?.headers).get('authorization'))
        return new Response(JSON.stringify({ data: [] }), {
          headers: { 'content-type': 'application/json' },
        })
      }) as unknown as typeof fetch,
    })

    await client.models.list()
    expect(seen).toEqual(['Bearer sk-test'])
  })
})
