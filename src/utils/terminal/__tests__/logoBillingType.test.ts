import { afterEach, describe, expect, mock, test } from 'bun:test'
import { authMockWith } from '../../../../tests/mocks/auth.js'

// auth via the shared complete-surface mock; subscription off so the branch
// under test (ChatGPT OAuth vs API billing) is reachable.
mock.module(
  'src/utils/auth/auth.js',
  authMockWith({
    isClaudeAISubscriber: () => false,
    getSubscriptionName: () => 'Claude Pro',
  }),
)

// MACRO is a build-time define; provide it for bare test runtime (same pattern
// as mcp.test.ts).
if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const { getLogoDisplayData } = await import('../logoV2Utils.js')

const savedAuthMode = process.env.OPENAI_AUTH_MODE
afterEach(() => {
  if (savedAuthMode === undefined) delete process.env.OPENAI_AUTH_MODE
  else process.env.OPENAI_AUTH_MODE = savedAuthMode
})

describe('getLogoDisplayData billingType', () => {
  test('ChatGPT OAuth session → ChatGPT Subscription, not API Usage Billing', () => {
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    expect(getLogoDisplayData().billingType).toBe('ChatGPT Subscription')
  })

  test('API key session → API Usage Billing', () => {
    delete process.env.OPENAI_AUTH_MODE
    expect(getLogoDisplayData().billingType).toBe('API Usage Billing')
  })
})
