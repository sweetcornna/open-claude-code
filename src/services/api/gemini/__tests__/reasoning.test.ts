import { describe, expect, test } from 'bun:test'
import { applyGeminiEffortToThinkingBudget } from '../reasoning.js'

describe('applyGeminiEffortToThinkingBudget', () => {
  test('high is the identity, so an untouched session is unchanged', () => {
    expect(applyGeminiEffortToThinkingBudget(10_000, 'high')).toBe(10_000)
  })

  test('scales monotonically across the ladder', () => {
    const budgets = ['low', 'medium', 'high', 'xhigh', 'max'].map(level =>
      applyGeminiEffortToThinkingBudget(10_000, level),
    )
    expect(budgets).toEqual([2_500, 5_000, 10_000, 15_000, 20_000])
  })

  test('never rounds down into "thinking off"', () => {
    // 0 disables thinking outright on this API, which is a different thing from
    // the small budget `low` asks for.
    expect(applyGeminiEffortToThinkingBudget(10, 'low')).toBe(128)
  })

  test('leaves the "you decide" sentinel alone', () => {
    expect(applyGeminiEffortToThinkingBudget(-1, 'max')).toBe(-1)
  })

  test('no effort chosen means no scaling', () => {
    expect(applyGeminiEffortToThinkingBudget(10_000, undefined)).toBe(10_000)
    expect(applyGeminiEffortToThinkingBudget(10_000, 80)).toBe(10_000)
  })
})
