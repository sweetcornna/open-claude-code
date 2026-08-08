import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  countWebSearch,
  isWebSearchBudgetExhausted,
  maxWebSearchesPerSession,
  resetWebSearchCount,
} from '../sessionLimit.js'

describe('web search session limit', () => {
  const savedEnv = process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION

  beforeEach(() => {
    resetWebSearchCount()
    delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
  })

  afterEach(() => {
    resetWebSearchCount()
    if (savedEnv === undefined)
      delete process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION
    else process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = savedEnv
  })

  test('unlimited unless a cap is configured', () => {
    expect(maxWebSearchesPerSession()).toBe(Number.POSITIVE_INFINITY)
    expect(isWebSearchBudgetExhausted()).toBe(false)
  })

  test('no amount of searching exhausts an unset budget', () => {
    for (let i = 0; i < 500; i++) countWebSearch()
    expect(isWebSearchBudgetExhausted()).toBe(false)
  })

  test('env override wins; garbage and non-positive mean unlimited', () => {
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '3'
    expect(maxWebSearchesPerSession()).toBe(3)
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = 'many'
    expect(maxWebSearchesPerSession()).toBe(Number.POSITIVE_INFINITY)
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '0'
    expect(maxWebSearchesPerSession()).toBe(Number.POSITIVE_INFINITY)
  })

  test('a cap set mid-session applies to searches already counted', () => {
    countWebSearch()
    countWebSearch()
    expect(isWebSearchBudgetExhausted()).toBe(false)
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '2'
    expect(isWebSearchBudgetExhausted()).toBe(true)
  })

  test('budget exhausts after the configured number of searches', () => {
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '2'
    expect(isWebSearchBudgetExhausted()).toBe(false)
    countWebSearch()
    expect(isWebSearchBudgetExhausted()).toBe(false)
    countWebSearch()
    expect(isWebSearchBudgetExhausted()).toBe(true)
  })
})
