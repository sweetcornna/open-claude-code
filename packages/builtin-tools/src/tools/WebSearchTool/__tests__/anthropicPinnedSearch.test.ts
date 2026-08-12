/**
 * The Anthropic search lane when a credential has been pinned.
 *
 * A pin has to change where the request goes, not just what the panel says
 * about it. Unpinned, this lane builds an SDK client out of ANTHROPIC_* env —
 * which after a `/provider use` can hold another provider's mirrored token and
 * a base URL pointing at their gateway. So the pinned path is a standalone
 * request at the endpoint the pin carries, and this file asserts exactly that:
 * the URL, and the header the key travels in.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { registerAPIRetryHost } from '@open-claude-code/tool-runtime/apiRetry.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { retryOpenAIRequest } from 'src/services/api/openai/retry.js'
import { occConfigDir } from 'src/config/paths.js'
import {
  pinSearchCredential,
  reloadPinnedSearchCredentials,
} from 'src/services/search/searchCredentialStore.js'
import { AnthropicDirectSearchAdapter } from '../adapters/apiAdapter'

type Captured = {
  url: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function stubFetch(reply: {
  status?: number
  body?: unknown
  text?: string
}): typeof fetch & { calls: Captured[] } {
  const calls: Captured[] = []
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    })
    const status = reply.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => reply.body,
      text: async () => reply.text ?? JSON.stringify(reply.body ?? ''),
    } as unknown as Response
  }) as unknown as typeof fetch & { calls: Captured[] }
  impl.calls = calls
  return impl
}

const RESULT_BODY = {
  content: [
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_1',
      content: [
        {
          type: 'web_search_result',
          title: 'Example',
          url: 'https://example.com/a',
        },
      ],
    },
  ],
}

const savedConfigDir = process.env.OCC_CONFIG_DIR
let tempDir: string

beforeEach(() => {
  // The real retry ladder, with the backoff removed: a 400 must still reach the
  // caller as the error it was, not as a facade fallback that never retried.
  registerAPIRetryHost({
    retry: (operation, options) =>
      retryOpenAIRequest(operation, { ...options, delay: async () => {} }),
  })
  tempDir = mkdtempSync(join(tmpdir(), 'occ-anthropic-pin-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

afterEach(() => {
  registerAPIRetryHost(null)
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  rmSync(tempDir, { recursive: true, force: true })
})

describe('AnthropicDirectSearchAdapter with a pinned credential', () => {
  test('posts to the pinned endpoint with the pinned key', async () => {
    await pinSearchCredential('anthropic', { apiKey: 'sk-ant-pinned' })
    const fetchOverride = stubFetch({ body: RESULT_BODY })

    const results = await new AnthropicDirectSearchAdapter({
      fetchOverride,
    }).search('occ web search', {})

    expect(fetchOverride.calls).toHaveLength(1)
    expect(fetchOverride.calls[0]?.url).toBe(
      'https://api.anthropic.com/v1/messages',
    )
    // x-api-key, not a bearer: the two are NOT interchangeable, and a bearer
    // alone comes back "Missing API key".
    expect(fetchOverride.calls[0]?.headers['x-api-key']).toBe('sk-ant-pinned')
    expect(fetchOverride.calls[0]?.headers['anthropic-version']).toBe(
      '2023-06-01',
    )
    expect(results).toEqual([
      { title: 'Example', url: 'https://example.com/a' },
    ])
  })

  test('honours an endpoint carried by the pin', async () => {
    await pinSearchCredential('anthropic', {
      apiKey: 'sk-ant-pinned',
      baseURL: 'https://gateway.example/anthropic',
    })
    const fetchOverride = stubFetch({ body: RESULT_BODY })

    await new AnthropicDirectSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.url).toBe(
      'https://gateway.example/anthropic/v1/messages',
    )
  })

  test('declares the server-side search tool', async () => {
    await pinSearchCredential('anthropic', { apiKey: 'sk-ant-pinned' })
    const fetchOverride = stubFetch({ body: RESULT_BODY })

    await new AnthropicDirectSearchAdapter({ fetchOverride }).search('q', {})

    expect(fetchOverride.calls[0]?.body.tools).toMatchObject([
      { type: 'web_search_20250305', name: 'web_search' },
    ])
  })

  test('a failure carries the status and body, so the source can be retired', async () => {
    await pinSearchCredential('anthropic', { apiKey: 'sk-ant-pinned' })
    const fetchOverride = stubFetch({
      status: 400,
      text: 'tool web_search is not supported',
    })

    await expect(
      new AnthropicDirectSearchAdapter({ fetchOverride }).search('q', {}),
    ).rejects.toThrow(/web_search is not supported/)
  })

  test('with nothing pinned the lane does not touch the pinned path', async () => {
    const fetchOverride = stubFetch({ body: RESULT_BODY })
    const controller = new AbortController()

    // No pin, so this enters the SDK-client branch. Cancel after the async call
    // has reached that branch; the pinned fetch must remain untouched, and the
    // test must not depend on ambient credentials or a real network response.
    const request = new AnthropicDirectSearchAdapter({ fetchOverride }).search(
      'q',
      { signal: controller.signal },
    )
    controller.abort()
    await request.catch(() => undefined)

    expect(fetchOverride.calls).toHaveLength(0)
  })
})
