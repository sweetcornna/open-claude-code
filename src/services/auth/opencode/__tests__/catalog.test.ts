/**
 * The credential probe that stands between a device code and an active session.
 *
 * Every response body below was copied from the live service (2026-08-10),
 * because the whole point of this check is a distinction only the service
 * makes: `Missing API key.` when no bearer arrives, `Invalid API key.` when one
 * arrives and is refused, and a plain upstream complaint about the empty
 * `messages` array when the bearer is accepted. That last one is what makes the
 * probe free — the gateway authenticates before it validates the body, so an
 * accepted credential never reaches inference and never bills.
 *
 * `fetch` is stubbed directly, the way deviceFlow.test.ts does it: this module
 * is pure transport over an injected URL and nothing here touches the config
 * dir.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { fetchOpencodeConsoleConfig, verifyOpencodeAccess } from '../catalog.js'
import type { OpencodeCredential } from '../oauth.js'

const realFetch = globalThis.fetch
const calls: { url: string; init?: RequestInit }[] = []

function stubFetch(status: number, json: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), ...(init ? { init } : {}) })
    return new Response(JSON.stringify(json), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

afterEach(() => {
  globalThis.fetch = realFetch
  calls.length = 0
})

const GO = 'https://opencode.ai/zen/go/v1'
const credential: OpencodeCredential = {
  token: 'access-token',
  kind: 'oauth',
  server: 'https://console.opencode.ai',
  orgId: 'org-1',
}

describe('verifyOpencodeAccess', () => {
  test('a refused credential is a rejection, with the service’s own reason', async () => {
    stubFetch(401, {
      type: 'error',
      error: { type: 'AuthError', message: 'Invalid API key.' },
    })
    expect(
      await verifyOpencodeAccess(credential, GO, 'deepseek-v4-flash'),
    ).toEqual({ ok: false, reason: 'Invalid API key.' })
  })

  test('a missing credential is a rejection too', async () => {
    stubFetch(401, {
      type: 'error',
      error: { type: 'AuthError', message: 'Missing API key.' },
    })
    const result = await verifyOpencodeAccess(credential, GO, 'kimi-k3')
    expect(result.ok).toBe(false)
  })

  test('the upstream complaining about the empty body means the bearer got in', async () => {
    // Verified with Zen's free `Bearer public`: 400, and no completion is
    // produced — which is exactly why an empty `messages` array is the probe.
    stubFetch(400, {
      error: {
        type: 'server_error',
        message:
          'Error from provider (Console): Upstream request failed: [400] Input required: specify "prompt" or "messages"',
      },
    })
    expect(await verifyOpencodeAccess(credential, GO, 'kimi-k3')).toEqual({
      ok: true,
    })
  })

  test('an unknown model id is not an auth verdict, even at 401', async () => {
    // The gateway really does answer ModelError with status 401 (verified).
    // Classifying on the status alone would fail a working account whenever
    // occ guessed the probe model wrong.
    stubFetch(401, {
      type: 'error',
      error: {
        type: 'ModelError',
        message: 'Model {{model}} is not supported',
      },
    })
    expect(await verifyOpencodeAccess(credential, GO, 'not-a-model')).toEqual({
      ok: true,
    })
  })

  test('a 401 with nothing readable in it still counts as refused', async () => {
    globalThis.fetch = (async () =>
      new Response('gateway says no', {
        status: 401,
      })) as unknown as typeof fetch
    const result = await verifyOpencodeAccess(credential, GO, 'kimi-k3')
    expect(result).toEqual({ ok: false, reason: 'HTTP 401' })
  })

  test('a transport failure is not a verdict', async () => {
    // The device flow reached the console seconds earlier, so a throw here is a
    // flaky network. Blocking the login on it would be worse than the failure
    // this check exists to prevent.
    globalThis.fetch = (async () => {
      throw new Error('ECONNRESET')
    }) as unknown as typeof fetch
    expect(await verifyOpencodeAccess(credential, GO, 'kimi-k3')).toEqual({
      ok: true,
    })
  })

  test('the probe is aimed at the configured product and carries the credential', async () => {
    stubFetch(400, { error: { type: 'server_error', message: 'empty' } })
    await verifyOpencodeAccess(credential, GO, 'deepseek-v4-flash')

    expect(calls[0]?.url).toBe(`${GO}/chat/completions`)
    const headers = calls[0]?.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer access-token')
    // Multi-org accounts bill whichever org the console defaults to without it.
    expect(headers['x-org-id']).toBe('org-1')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'deepseek-v4-flash',
      messages: [],
    })
  })
})

/**
 * The Console inference plane, read off `/api/config`.
 *
 * The body below is the live console's answer with a real access token
 * (2026-08-11), trimmed to the fields occ reads. It is the whole reason this
 * exists: the same token answers 200 at `provider.opencode.api` and 401
 * `AuthError: Invalid API key.` at the Zen base URL occ used to hard-code, so
 * the endpoint cannot be a constant — and neither can the headers, whose
 * `x-org-id` is per account.
 */
const CONSOLE_CONFIG = {
  config: {
    provider: {
      opencode: {
        name: 'opencode',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://console.opencode.ai/inference/openai/v1',
        env: ['OPENCODE_CONSOLE_TOKEN'],
        options: {
          apiKey: '{env:OPENCODE_CONSOLE_TOKEN}',
          headers: { 'x-org-id': 'org_01KZ', 'x-ignored': 7 },
        },
        models: {
          'big-pickle': { name: 'Big Pickle' },
          'claude-haiku-4-5': { name: 'Claude Haiku 4.5', status: 'active' },
        },
      },
    },
  },
}

describe('fetchOpencodeConsoleConfig', () => {
  test('reads the endpoint, the headers and the entitlement models', async () => {
    stubFetch(200, CONSOLE_CONFIG)
    const config = await fetchOpencodeConsoleConfig(credential)

    expect(calls[0]?.url).toBe('https://console.opencode.ai/api/config')
    expect(config?.inference).toEqual({
      api: 'https://console.opencode.ai/inference/openai/v1',
      // Non-string header values are dropped rather than passed through: they
      // reach fetch as headers and would throw at request time, not read time.
      headers: { 'x-org-id': 'org_01KZ' },
    })
    expect(config?.models?.map(model => model.id)).toEqual([
      'big-pickle',
      'claude-haiku-4-5',
    ])
  })

  test('a config with no api names no plane', async () => {
    // Nothing is invented: without an endpoint from the console the caller
    // keeps whatever it already had, and the probe decides whether that works.
    stubFetch(200, {
      config: { provider: { opencode: { models: { 'big-pickle': {} } } } },
    })
    const config = await fetchOpencodeConsoleConfig(credential)
    expect(config?.inference).toBeUndefined()
    expect(config?.models).toHaveLength(1)
  })

  test('a key credential has no account to ask', async () => {
    stubFetch(200, CONSOLE_CONFIG)
    expect(
      await fetchOpencodeConsoleConfig({ token: 'zen-key', kind: 'key' }),
    ).toBeNull()
    expect(calls).toHaveLength(0)
  })

  test('404 is “no remote config”, not an error', async () => {
    stubFetch(404, { error: 'not found' })
    expect(await fetchOpencodeConsoleConfig(credential)).toBeNull()
  })
})

describe('a model the organization may not use', () => {
  test('is not an auth verdict', async () => {
    // Measured: `claude-haiku-4-5` on the console plane answers 403 with this
    // body while `/api/config` reports it `status: "active"`. It is the model
    // that was refused, not the credential — rejecting the login for it would
    // block a working account over a probe model occ chose itself.
    stubFetch(403, {
      error: {
        type: 'managed_inference_model_disabled',
        message: 'Model is disabled for this organization',
      },
    })
    expect(
      await verifyOpencodeAccess(
        credential,
        'https://console.opencode.ai/inference/openai/v1',
        'claude-haiku-4-5',
      ),
    ).toEqual({ ok: true })
  })
})
