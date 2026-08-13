import { afterEach, describe, expect, test } from 'bun:test'
import {
  API_KEY_AUTH_DISABLED_ENV_ERROR_MESSAGE,
  API_KEY_AUTH_DISABLED_ENV_WITH_OAUTH_ERROR_MESSAGE,
  API_KEY_AUTH_DISABLED_HELPER_ERROR_MESSAGE,
  API_KEY_AUTH_DISABLED_MANAGED_ERROR_MESSAGE,
  API_KEY_HELPER_FAILED_ERROR_MESSAGE,
  getApiKeyAuthErrorCopy,
  SERVER_TEMPORARILY_LIMITING_ERROR_MESSAGE,
} from '../errors.js'

const originalApiKey = process.env.ANTHROPIC_API_KEY

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
})

describe('getApiKeyAuthErrorCopy', () => {
  test('explains a failing apiKeyHelper before generic 401 handling', () => {
    expect(
      getApiKeyAuthErrorCopy({
        status: 401,
        message: 'authentication failed',
        provider: 'firstParty',
        source: 'apiKeyHelper',
        hasStoredOAuth: false,
        apiKeyHelperError: 'exited 1',
      }),
    ).toEqual({
      content: API_KEY_HELPER_FAILED_ERROR_MESSAGE,
      error: 'invalid_request',
    })
  })

  test('does not attribute third-party auth failures to apiKeyHelper', () => {
    expect(
      getApiKeyAuthErrorCopy({
        status: 401,
        message: 'authentication failed',
        provider: 'openai',
        source: 'apiKeyHelper',
        hasStoredOAuth: false,
        apiKeyHelperError: 'exited 1',
      }),
    ).toBeUndefined()
  })

  test('distinguishes the four disabled API key authentication contexts', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    const base = {
      status: 403,
      message: 'API key authentication is disabled for this organization',
      provider: 'firstParty',
      apiKeyHelperError: null,
    }

    expect(
      getApiKeyAuthErrorCopy({
        ...base,
        source: 'ANTHROPIC_API_KEY',
        hasStoredOAuth: true,
      }),
    ).toEqual({
      content: API_KEY_AUTH_DISABLED_ENV_WITH_OAUTH_ERROR_MESSAGE,
      error: 'invalid_request',
    })
    expect(
      getApiKeyAuthErrorCopy({
        ...base,
        source: 'ANTHROPIC_API_KEY',
        hasStoredOAuth: false,
      }),
    ).toEqual({
      content: API_KEY_AUTH_DISABLED_ENV_ERROR_MESSAGE,
      error: 'invalid_request',
    })
    expect(
      getApiKeyAuthErrorCopy({
        ...base,
        source: 'apiKeyHelper',
        hasStoredOAuth: false,
      }),
    ).toEqual({
      content: API_KEY_AUTH_DISABLED_HELPER_ERROR_MESSAGE,
      error: 'invalid_request',
    })
    expect(
      getApiKeyAuthErrorCopy({
        ...base,
        source: '/login managed key',
        hasStoredOAuth: false,
      }),
    ).toEqual({
      content: API_KEY_AUTH_DISABLED_MANAGED_ERROR_MESSAGE,
      error: 'authentication_failed',
    })
  })

  test('requires the official status and error phrase', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test'
    for (const [status, message] of [
      [401, 'API key authentication is disabled'],
      [403, 'permission denied'],
    ] as const) {
      expect(
        getApiKeyAuthErrorCopy({
          status,
          message,
          provider: 'firstParty',
          source: 'ANTHROPIC_API_KEY',
          hasStoredOAuth: true,
          apiKeyHelperError: null,
        }),
      ).toBeUndefined()
    }
  })
})

test('keeps the official transient 429 copy distinct from usage limits', () => {
  expect(SERVER_TEMPORARILY_LIMITING_ERROR_MESSAGE).toBe(
    'Server is temporarily limiting requests (not your usage limit)',
  )
})
