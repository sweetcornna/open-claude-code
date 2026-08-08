import { describe, expect, test } from 'bun:test'
import { resolveAnthropicBaseURL } from '../client.js'

describe('resolveAnthropicBaseURL', () => {
  test('lets the SDK append one version segment', () => {
    expect(resolveAnthropicBaseURL('https://opencode.ai/zen/go/v1')).toEqual({
      baseURL: 'https://opencode.ai/zen/go',
    })
    expect(resolveAnthropicBaseURL('https://opencode.ai/zen/go/v1/')).toEqual({
      baseURL: 'https://opencode.ai/zen/go',
    })
  })

  test('preserves compatible bases without a version segment', () => {
    expect(
      resolveAnthropicBaseURL('https://api.deepseek.com/anthropic'),
    ).toEqual({ baseURL: 'https://api.deepseek.com/anthropic' })
  })

  test('hands query parameters to the SDK separately from the base URL', () => {
    expect(
      resolveAnthropicBaseURL(
        'https://gateway.example/Tenant/V1/MESSAGES/?api-version=AbC#fragment',
      ),
    ).toEqual({
      baseURL: 'https://gateway.example/Tenant',
      defaultQuery: { 'api-version': 'AbC' },
    })
  })

  test('ignores blank values', () => {
    expect(resolveAnthropicBaseURL('  ')).toBeUndefined()
    expect(resolveAnthropicBaseURL(undefined)).toBeUndefined()
  })

  test('falls back to the raw value instead of throwing at construction time', () => {
    // A missing scheme reaches `new URL()` and used to take the whole client
    // constructor down with a TypeError — before any request existed, so no
    // retry ladder saw it and no API error message was ever produced. Passing
    // the value straight through lets the SDK fail the request normally.
    expect(resolveAnthropicBaseURL('api.example.com/v1')).toEqual({
      baseURL: 'api.example.com/v1',
    })
    expect(resolveAnthropicBaseURL('ftp://gateway.example/v1')).toEqual({
      baseURL: 'ftp://gateway.example/v1',
    })
  })
})
