import { describe, expect, test } from 'bun:test'
import { resolveGrokReasoningEffort } from '../reasoning.js'

describe('resolveGrokReasoningEffort', () => {
  test('collapses occ five rungs onto xAI two', () => {
    const model = 'grok-3-mini-fast'
    expect(resolveGrokReasoningEffort(model, 'low')).toBe('low')
    expect(resolveGrokReasoningEffort(model, 'medium')).toBe('high')
    expect(resolveGrokReasoningEffort(model, 'high')).toBe('high')
    expect(resolveGrokReasoningEffort(model, 'xhigh')).toBe('high')
    expect(resolveGrokReasoningEffort(model, 'max')).toBe('high')
  })

  test('sends nothing for the grok-4 reasoning models', () => {
    // They always reason and REJECT the field: sending it would turn a
    // preference into a 400 on every request of the session.
    for (const level of ['low', 'high', 'max']) {
      expect(
        resolveGrokReasoningEffort('grok-4.20-reasoning', level),
      ).toBeUndefined()
    }
  })

  test('sends nothing when no effort was chosen', () => {
    expect(
      resolveGrokReasoningEffort('grok-3-mini-fast', undefined),
    ).toBeUndefined()
    // The ant-only numeric efforts have no rung on this ladder.
    expect(resolveGrokReasoningEffort('grok-3-mini-fast', 80)).toBeUndefined()
  })
})
