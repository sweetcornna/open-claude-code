/**
 * The Codex/OpenAI search lane when a credential has been pinned.
 *
 * A pin has to change what goes on the wire, not just what the panel says about
 * it. Unpinned, this lane authenticates from `OPENAI_API_KEY`/`OPENAI_BASE_URL`
 * inside `createOpenAIResponsesStream` — which is exactly what `/logout` and
 * `/provider use` delete. So the pinned path hands that function an explicit
 * `credential`, and this file asserts what arrives at fetch: the URL, and the
 * bearer the key travels in.
 *
 * No module mocks. Every branch here is a function of process.env plus a real
 * 0600 store under a temporary OCC_CONFIG_DIR, and "the pinned key was sent" is
 * only meaningful about the real resolution path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { occConfigDir } from 'src/config/paths.js'
import {
  pinSearchCredential,
  reloadPinnedSearchCredentials,
} from 'src/services/search/searchCredentialStore.js'
import { CodexSearchAdapter } from '../adapters/codexAdapter'

type Captured = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

const SEARCH_EVENTS = [
  {
    type: 'response.output_item.done',
    item: {
      type: 'web_search_call',
      action: {
        type: 'search',
        query: 'occ pinned search',
        sources: [{ url: 'https://example.com/a', title: 'A' }],
      },
    },
  },
  // A terminal event, or the SSE reader treats the stream as truncated and the
  // real retry ladder sleeps its way past the test timeout.
  { type: 'response.completed', response: { output: [] } },
]

function stubFetch(): typeof fetch & { calls: Captured[] } {
  const calls: Captured[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const body = `${SEARCH_EVENTS.map(event => `data: ${JSON.stringify(event)}`).join('\n\n')}\n\n`
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
  }) as unknown as typeof fetch & { calls: Captured[] }
  impl.calls = calls
  return impl
}

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'OPENAI_AUTH_MODE',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_MODEL',
] as const

const savedEnv = new Map<string, string | undefined>()
const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  for (const key of ENV_KEYS) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  // Pin the model so getMainLoopModel() never walks into the auth stack, which
  // throws outright when no Anthropic credential is configured.
  process.env.ANTHROPIC_MODEL = 'claude-sonnet-4-5-20250929'
  tempDir = mkdtempSync(join(tmpdir(), 'occ-codex-pin-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('CodexSearchAdapter with a pinned credential', () => {
  test('sends the pinned key to OpenAI with no OPENAI_* left in the env', async () => {
    // Exactly the post-`/logout` / post-`/provider use` state: the keys this
    // lane used to authenticate from are simply gone.
    await pinSearchCredential('codex', { apiKey: 'sk-pinned' })
    const fetchOverride = stubFetch()

    const results = await new CodexSearchAdapter({ fetchOverride }).search(
      'occ pinned search',
      {},
    )

    expect(fetchOverride.calls).toHaveLength(1)
    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(fetchOverride.calls[0]?.headers.Authorization).toBe(
      'Bearer sk-pinned',
    )
    expect(fetchOverride.calls[0]?.body.tools).toEqual([{ type: 'web_search' }])
    expect(results).toEqual([{ title: 'A', url: 'https://example.com/a' }])
  })

  test('does not inherit OPENAI_BASE_URL — the key would go to a third party', async () => {
    // The session is on DeepSeek; the pin is an OpenAI key. Completing the
    // endpoint half from the environment would post that key to api.deepseek.com.
    await pinSearchCredential('codex', { apiKey: 'sk-pinned' })
    process.env.OPENAI_API_KEY = 'sk-deepseek-session'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(fetchOverride.calls[0]?.headers.Authorization).toBe(
      'Bearer sk-pinned',
    )
  })

  test('honours an endpoint carried by the pin', async () => {
    await pinSearchCredential('codex', {
      apiKey: 'sk-pinned',
      baseURL: 'https://api.openai.com/v1',
    })
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.openai.com/v1/responses',
    )
  })

  test('outranks OPENAI_AUTH_MODE=chatgpt instead of being quietly dropped', async () => {
    // Without the pin this configuration routes to chatgpt.com's Codex backend
    // and authenticates as that account. A pin is the user naming a credential,
    // so it stands that route down — the same rule usesAntigravityRoute applies
    // to an explicit Gemini key.
    await pinSearchCredential('codex', { apiKey: 'sk-pinned' })
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.openai.com/v1/responses',
    )
    expect(fetchOverride.calls[0]?.headers.Authorization).toBe(
      'Bearer sk-pinned',
    )
  })

  test('sends a model OpenAI serves, not the session’s third-party one', async () => {
    // A pin decouples this lane's endpoint from the session's, so the session
    // model can be one api.openai.com has never heard of. Forwarding it earns a
    // 400 the aggregator silences — the pin would have changed nothing.
    await pinSearchCredential('codex', { apiKey: 'sk-pinned' })
    process.env.OPENAI_MODEL = 'deepseek-v4-flash'
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.body.model).toBe('gpt-5.6-luna')
  })

  test('keeps an explicitly configured OpenAI model', async () => {
    await pinSearchCredential('codex', { apiKey: 'sk-pinned' })
    process.env.OPENAI_MODEL = 'gpt-5.6-sol'
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.body.model).toBe('gpt-5.6-sol')
  })

  test('with nothing pinned the lane is the environment’s, unchanged', async () => {
    process.env.OPENAI_API_KEY = 'sk-session'
    process.env.OPENAI_BASE_URL = 'https://api.openai.test/v1'
    const fetchOverride = stubFetch()

    await new CodexSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.openai.test/v1/responses',
    )
    expect(fetchOverride.calls[0]?.headers.Authorization).toBe(
      'Bearer sk-session',
    )
  })
})
