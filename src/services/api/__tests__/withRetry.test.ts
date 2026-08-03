import { describe, expect, mock, test } from 'bun:test'
import type Anthropic from '@anthropic-ai/sdk'
import { APIError } from '@anthropic-ai/sdk'
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/auth/auth.js', authMockWith())
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

import { withRetry } from '../withRetry.js'

describe('withRetry context overflow adjustment', () => {
  test('does not retry when thinking alone exceeds the remaining context', async () => {
    const overflow = new APIError(
      400,
      {
        error: {
          message:
            'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000',
        },
      },
      'input length and `max_tokens` exceed context limit: 195000 + 20000 > 200000',
      new Headers(),
    )
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async (_client, _attempt, context) => {
        calls++
        if (calls === 1) throw overflow
        return context.maxTokensOverride
      },
      {
        maxRetries: 1,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'enabled', budgetTokens: 5_000 },
      },
    )

    await expect(generator.next()).rejects.toBe(overflow)
    expect(calls).toBe(1)
  })

  test('caps a retry max_tokens value at the remaining context', async () => {
    const overflow = new APIError(
      400,
      {
        error: {
          message:
            'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
        },
      },
      'input length and `max_tokens` exceed context limit: 190000 + 20000 > 200000',
      new Headers(),
    )
    let calls = 0
    const generator = withRetry(
      async () => ({}) as unknown as Anthropic,
      async (_client, _attempt, context) => {
        calls++
        if (calls === 1) throw overflow
        return context.maxTokensOverride
      },
      {
        maxRetries: 1,
        model: 'claude-sonnet',
        thinkingConfig: { type: 'enabled', budgetTokens: 3_000 },
      },
    )

    const result = await generator.next()
    expect(result).toEqual({ done: true, value: 9_000 })
    expect(calls).toBe(2)
  })
})
