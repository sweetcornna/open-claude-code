import { afterEach, describe, expect, test } from 'bun:test'
import {
  getChatReasoningEffort,
  getResponsesReasoningEffort,
} from '../reasoning.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

describe('OpenAI reasoning effort defaults', () => {
  test('uses the GPT family xhigh default on Responses', () => {
    expect(getResponsesReasoningEffort('gpt-5.6-sol', undefined)).toBe('xhigh')
    expect(getResponsesReasoningEffort('gpt-5.6-sol-preview', undefined)).toBe(
      'xhigh',
    )
    expect(getResponsesReasoningEffort('gpt-5.6-terra', undefined)).toBe(
      'xhigh',
    )
  })

  test('clamps the GPT family default to high on Chat Completions', () => {
    expect(getChatReasoningEffort('gpt-5.6-sol', undefined)).toBe('high')
  })

  test('an explicit effort value takes priority over the model default', () => {
    expect(getResponsesReasoningEffort('gpt-5.6-sol', 'high')).toBe('high')
  })

  test('auto and unset continue to omit the reasoning field', () => {
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'auto'
    expect(
      getResponsesReasoningEffort('gpt-5.6-sol', undefined),
    ).toBeUndefined()
    process.env.CLAUDE_CODE_EFFORT_LEVEL = 'unset'
    expect(getChatReasoningEffort('gpt-5.6-sol', undefined)).toBeUndefined()
  })
})
