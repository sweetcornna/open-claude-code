import { afterEach, describe, expect, test } from 'bun:test'
import type { GeminiGenerateContentRequest } from '@ant/model-provider'
import {
  antigravityHeaders,
  antigravityStreamUrl,
  deriveAntigravitySessionId,
  getAntigravityBaseUrl,
  unwrapAntigravityChunk,
  wrapAntigravityRequest,
} from '../antigravityWire.js'

const ORIGINAL_BASE_URL = process.env.GEMINI_BASE_URL

afterEach(() => {
  if (ORIGINAL_BASE_URL === undefined) delete process.env.GEMINI_BASE_URL
  else process.env.GEMINI_BASE_URL = ORIGINAL_BASE_URL
})

function body(
  overrides: Partial<GeminiGenerateContentRequest> = {},
): GeminiGenerateContentRequest {
  return {
    contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    ...overrides,
  } as GeminiGenerateContentRequest
}

describe('base URL and endpoint', () => {
  test('defaults to the daily Cloud Code host the IDE prefers', () => {
    delete process.env.GEMINI_BASE_URL
    expect(getAntigravityBaseUrl()).toBe(
      'https://daily-cloudcode-pa.googleapis.com',
    )
  })

  test('GEMINI_BASE_URL still wins so a proxy in front keeps working', () => {
    process.env.GEMINI_BASE_URL = 'https://proxy.example.com/'
    expect(getAntigravityBaseUrl()).toBe('https://proxy.example.com')
  })

  test('streams over the v1internal endpoint, not the public models/ path', () => {
    delete process.env.GEMINI_BASE_URL
    expect(antigravityStreamUrl()).toBe(
      'https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
    )
  })
})

describe('antigravityHeaders', () => {
  test('sends a bearer token and never the API-key header', () => {
    const headers = antigravityHeaders('tok-123')
    expect(headers.Authorization).toBe('Bearer tok-123')
    expect(headers).not.toHaveProperty('x-goog-api-key')
  })

  test('carries the Antigravity IDE User-Agent the backend gates on', () => {
    expect(antigravityHeaders('t')['User-Agent']).toMatch(
      /^antigravity\/hub\/\d+\.\d+\.\d+ /,
    )
  })
})

describe('wrapAntigravityRequest', () => {
  test('nests the Gemini body under `request` with the routing envelope', () => {
    const envelope = wrapAntigravityRequest({
      model: 'gemini-pro-agent',
      projectId: 'proj-42',
      body: body(),
      requestId: 'agent-fixed',
      sessionId: '-7',
    })
    expect(envelope.model).toBe('gemini-pro-agent')
    expect(envelope.project).toBe('proj-42')
    expect(envelope.userAgent).toBe('antigravity')
    expect(envelope.requestType).toBe('agent')
    expect(envelope.requestId).toBe('agent-fixed')
    expect(envelope.request.contents).toEqual(body().contents)
    expect(envelope.request.sessionId).toBe('-7')
  })

  test('generates an agent-prefixed requestId when none is injected', () => {
    const envelope = wrapAntigravityRequest({
      model: 'gemini-pro-agent',
      projectId: 'p',
      body: body(),
    })
    expect(envelope.requestId).toMatch(/^agent-[0-9a-f-]{36}$/)
  })

  test('drops maxOutputTokens for Gemini models — the backend 400s on a client cap', () => {
    const envelope = wrapAntigravityRequest({
      model: 'gemini-pro-agent',
      projectId: 'p',
      body: body({
        generationConfig: { temperature: 0.5, maxOutputTokens: 4096 },
      } as Partial<GeminiGenerateContentRequest>),
    })
    const config = envelope.request.generationConfig as Record<string, unknown>
    expect(config).not.toHaveProperty('maxOutputTokens')
    expect(config.temperature).toBe(0.5)
  })

  test('keeps maxOutputTokens for Claude models served through Antigravity', () => {
    const envelope = wrapAntigravityRequest({
      model: 'claude-sonnet-4-6',
      projectId: 'p',
      body: body({
        generationConfig: { maxOutputTokens: 4096 },
      } as Partial<GeminiGenerateContentRequest>),
    })
    expect(
      (envelope.request.generationConfig as Record<string, unknown>)
        .maxOutputTokens,
    ).toBe(4096)
  })

  test('strips safetySettings, which the backend rejects', () => {
    const envelope = wrapAntigravityRequest({
      model: 'gemini-pro-agent',
      projectId: 'p',
      body: body({
        safetySettings: [{ category: 'HARM', threshold: 'NONE' }],
      } as unknown as Partial<GeminiGenerateContentRequest>),
    })
    expect(envelope.request).not.toHaveProperty('safetySettings')
  })

  test('does not mutate the caller-owned body', () => {
    const original = body({
      generationConfig: { maxOutputTokens: 10 },
    } as Partial<GeminiGenerateContentRequest>)
    wrapAntigravityRequest({
      model: 'gemini-pro-agent',
      projectId: 'p',
      body: original,
    })
    expect(
      (original.generationConfig as Record<string, unknown>).maxOutputTokens,
    ).toBe(10)
    expect(original).not.toHaveProperty('sessionId')
  })
})

describe('deriveAntigravitySessionId', () => {
  test('is stable for the same first user message', () => {
    const a = deriveAntigravitySessionId(body())
    const b = deriveAntigravitySessionId(body())
    expect(a).toBe(b)
    expect(a).toMatch(/^-\d+$/)
  })

  test('differs across conversations', () => {
    const other = body({
      contents: [{ role: 'user', parts: [{ text: 'different' }] }],
    } as Partial<GeminiGenerateContentRequest>)
    expect(deriveAntigravitySessionId(body())).not.toBe(
      deriveAntigravitySessionId(other),
    )
  })

  test('skips leading non-user turns', () => {
    const withModelFirst = body({
      contents: [
        { role: 'model', parts: [{ text: 'ignored' }] },
        { role: 'user', parts: [{ text: 'hello' }] },
      ],
    } as Partial<GeminiGenerateContentRequest>)
    expect(deriveAntigravitySessionId(withModelFirst)).toBe(
      deriveAntigravitySessionId(body()),
    )
  })

  test('still produces an id when there is no user text at all', () => {
    const empty = body({
      contents: [],
    } as Partial<GeminiGenerateContentRequest>)
    expect(deriveAntigravitySessionId(empty)).toMatch(/^-\d+$/)
  })
})

describe('unwrapAntigravityChunk', () => {
  test('lifts the nested GenerateContentResponse out of the frame', () => {
    const inner = { candidates: [{ content: { parts: [{ text: 'hi' }] } }] }
    expect(unwrapAntigravityChunk({ response: inner })).toEqual(inner as never)
  })

  test('returns null for frames without a response so they are skipped', () => {
    expect(unwrapAntigravityChunk({})).toBeNull()
    expect(unwrapAntigravityChunk({ response: null })).toBeNull()
    expect(unwrapAntigravityChunk('data')).toBeNull()
    expect(unwrapAntigravityChunk(null)).toBeNull()
  })
})
