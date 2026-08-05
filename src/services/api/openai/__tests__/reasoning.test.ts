import { afterEach, describe, expect, test } from 'bun:test'
import {
  getChatReasoningEffort,
  getResponsesReasoningEffort,
} from '../reasoning.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_EFFORT_LEVEL
})

describe('OpenAI reasoning effort defaults', () => {
  test('defaults gpt-5.6-sol variants to low', () => {
    expect(getResponsesReasoningEffort('gpt-5.6-sol', undefined)).toBe('low')
    expect(getChatReasoningEffort('gpt-5.6-sol-preview', undefined)).toBe('low')
  })

  test('keeps other reasoning models at medium', () => {
    expect(getResponsesReasoningEffort('gpt-5.6-terra', undefined)).toBe(
      'medium',
    )
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
