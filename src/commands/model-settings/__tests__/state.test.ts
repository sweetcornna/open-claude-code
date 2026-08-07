import { describe, expect, test } from 'bun:test'
import { parseArgs, parseContextTokens } from '../state.js'

describe('parseContextTokens', () => {
  test('accepts a bare count, k and m', () => {
    expect(parseContextTokens('200000')).toBe(200_000)
    expect(parseContextTokens('272k')).toBe(272_000)
    expect(parseContextTokens('1m')).toBe(1_000_000)
    expect(parseContextTokens('1.05M')).toBe(1_050_000)
    expect(parseContextTokens(' 128K ')).toBe(128_000)
  })

  test('rejects anything that is not a positive count', () => {
    for (const bad of ['', 'abc', '0', '-1', '1g', '1 000']) {
      expect(parseContextTokens(bad)).toBeUndefined()
    }
  })
})

describe('parseArgs', () => {
  test('no args opens the panel', () => {
    expect(parseArgs(undefined)).toEqual({ kind: 'panel' })
    expect(parseArgs('   ')).toEqual({ kind: 'panel' })
  })

  test('show / current print the effective values', () => {
    expect(parseArgs('show')).toEqual({ kind: 'show' })
    expect(parseArgs('current')).toEqual({ kind: 'show' })
  })

  test('sets effort for one tier', () => {
    expect(parseArgs('opus effort max')).toEqual({
      kind: 'set',
      tier: 'opus',
      effort: 'max',
    })
  })

  test('sets context for one tier', () => {
    expect(parseArgs('haiku context 128k')).toEqual({
      kind: 'set',
      tier: 'haiku',
      contextTokens: 128_000,
    })
  })

  test('reset clears one tier', () => {
    expect(parseArgs('fable reset')).toEqual({ kind: 'reset', tier: 'fable' })
  })

  test('rejects an unknown tier by name', () => {
    const r = parseArgs('best effort max')
    expect(r.kind).toBe('error')
    expect((r as { message: string }).message).toContain('best')
  })

  test('rejects an unknown effort level and lists the valid ones', () => {
    const r = parseArgs('opus effort turbo')
    expect(r.kind).toBe('error')
    // The /effort command's own invalid-arg message omits xhigh; do not
    // reproduce that gap here.
    expect((r as { message: string }).message).toContain('xhigh')
    expect((r as { message: string }).message).toContain('max')
  })

  test('rejects an unreadable token count', () => {
    expect(parseArgs('opus context huge').kind).toBe('error')
  })

  test('a tier with no verb prints usage rather than doing nothing', () => {
    expect(parseArgs('opus').kind).toBe('error')
  })

  test('is case-insensitive on tier and level', () => {
    expect(parseArgs('OPUS EFFORT MAX')).toEqual({
      kind: 'set',
      tier: 'opus',
      effort: 'max',
    })
  })
})
