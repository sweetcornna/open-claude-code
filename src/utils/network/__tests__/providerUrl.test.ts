import { describe, expect, test } from 'bun:test'
import {
  buildProviderResourceURL,
  normalizeProviderBaseURL,
  splitProviderBaseURL,
} from '../providerUrl.js'

describe('normalizeProviderBaseURL', () => {
  test.each([
    [
      'https://gateway.example/tenant/v1',
      'anthropic' as const,
      'https://gateway.example/tenant',
    ],
    [
      'https://gateway.example/tenant/V1/MESSAGES///',
      'anthropic' as const,
      'https://gateway.example/tenant',
    ],
    [
      'https://gateway.example/tenant/v1/files/file_1/content',
      'anthropic' as const,
      'https://gateway.example/tenant',
    ],
    [
      'https://gateway.example/tenant/v1/chat/completions///',
      'openai' as const,
      'https://gateway.example/tenant/v1',
    ],
    [
      'https://gateway.example/tenant/v1/responses',
      'openai' as const,
      'https://gateway.example/tenant/v1',
    ],
    [
      'https://gateway.example/v1beta/models/gemini-pro:generateContent',
      'gemini' as const,
      'https://gateway.example/v1beta',
    ],
    [
      'https://gateway.example/v1internal:streamGenerateContent',
      'antigravity' as const,
      'https://gateway.example',
    ],
  ])('canonicalizes %s', (input, kind, expected) => {
    expect(normalizeProviderBaseURL(input, kind)).toBe(expected)
  })

  test.each([
    ['https://api.deepseek.com', 'https://api.deepseek.com/anthropic'],
    ['https://api.deepseek.com/v1', 'https://api.deepseek.com/anthropic'],
    [
      'https://api.deepseek.com/v1/chat/completions',
      'https://api.deepseek.com/anthropic',
    ],
    [
      'https://api.deepseek.com/anthropic/v1',
      'https://api.deepseek.com/anthropic',
    ],
    [
      'https://api.deepseek.com/anthropic/v1/messages',
      'https://api.deepseek.com/anthropic',
    ],
  ])('normalizes DeepSeek Anthropic base %s', (input, expected) => {
    expect(normalizeProviderBaseURL(input, 'deepseekAnthropic')).toBe(expected)
  })

  test.each([
    // `/models` behind a version segment is the OpenAI list endpoint.
    ['https://gw.example/v1/models', 'https://gw.example/v1'],
    ['https://gw.example/v1beta/models', 'https://gw.example/v1beta'],
    // Naming a model is always a resource, wherever it sits.
    ['https://gw.example/v1/models/gpt-5', 'https://gw.example/v1'],
    ['https://gw.example/zen/models/gpt-5', 'https://gw.example/zen'],
    // ...but a bare `models` segment anywhere else is somebody's proxy path.
    // Eating it silently retargets the whole deployment at `/zen`.
    ['https://gw.example/zen/models', 'https://gw.example/zen/models'],
    ['https://gw.example/models', 'https://gw.example/models'],
  ])('does not mistake the base path %s for a resource', (input, expected) => {
    expect(normalizeProviderBaseURL(input, 'openai')).toBe(expected)
  })

  test('preserves path and query case while dropping fragments', () => {
    expect(
      normalizeProviderBaseURL(
        'https://Gateway.Example/Tenant/Prod/v1/messages?ApiKey=AbC#wrong',
        'anthropic',
      ),
    ).toBe('https://gateway.example/Tenant/Prod?ApiKey=AbC')
  })

  test('uses one last-value-wins query contract on every wire', () => {
    expect(
      normalizeProviderBaseURL(
        'https://gateway.example/v1?tenant=old&trace=x&tenant=new',
        'openai',
      ),
    ).toBe('https://gateway.example/v1?tenant=new&trace=x')
  })

  test('rejects invalid and non-HTTP URLs', () => {
    expect(() => normalizeProviderBaseURL('not a URL', 'openai')).toThrow()
    expect(() =>
      normalizeProviderBaseURL('ftp://gateway.example/v1', 'openai'),
    ).toThrow(/http or https/)
  })
})

describe('splitProviderBaseURL', () => {
  test('separates SDK query parameters from the clean base URL', () => {
    expect(
      splitProviderBaseURL(
        'https://gateway.example/Prefix/v1/responses?api-version=2026-08-01&Tenant=Prod',
        'openai',
      ),
    ).toEqual({
      baseURL: 'https://gateway.example/Prefix/v1',
      defaultQuery: {
        'api-version': '2026-08-01',
        Tenant: 'Prod',
      },
    })
  })
})

describe('buildProviderResourceURL', () => {
  test('appends a resource after the proxy prefix and merges query params', () => {
    expect(
      buildProviderResourceURL(
        'https://gateway.example/Tenant/v1/responses?api-version=2026-08-01#wrong',
        'openai',
        'responses',
        { trace: 'AbC' },
      ),
    ).toBe(
      'https://gateway.example/Tenant/v1/responses?api-version=2026-08-01&trace=AbC',
    )
  })

  test('keeps a base query out of the DeepSeek Messages path', () => {
    // What getDeepSeekSearchEndpoint().messagesURL is built from. Concatenating
    // `${baseURL}/v1/messages` instead put the path inside the query string.
    expect(
      buildProviderResourceURL(
        'https://api.deepseek.com/v1?tenant=x',
        'deepseekAnthropic',
        'v1/messages',
      ),
    ).toBe('https://api.deepseek.com/anthropic/v1/messages?tenant=x')
  })

  test('does not duplicate Gemini models or stream resources', () => {
    expect(
      buildProviderResourceURL(
        'https://gateway.example/v1beta/models/gemini-old:streamGenerateContent?tenant=A',
        'gemini',
        'models/gemini-new:streamGenerateContent',
        { alt: 'sse' },
      ),
    ).toBe(
      'https://gateway.example/v1beta/models/gemini-new:streamGenerateContent?tenant=A&alt=sse',
    )
  })
})
