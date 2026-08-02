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

  test('defaults to 200', () => {
    expect(maxWebSearchesPerSession()).toBe(200)
  })

  test('env override wins; garbage falls back to default', () => {
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '3'
    expect(maxWebSearchesPerSession()).toBe(3)
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = 'many'
    expect(maxWebSearchesPerSession()).toBe(200)
    process.env.CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION = '0'
    expect(maxWebSearchesPerSession()).toBe(200)
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
