import { afterEach, describe, expect, test } from 'bun:test'
import {
  getOtelContentMaxLength,
  truncateContent,
} from '../otelContentLimit.js'

describe('OTel content limit', () => {
  const savedEnv = process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH

  afterEach(() => {
    if (savedEnv === undefined)
      delete process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH
    else process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = savedEnv
  })

  test('defaults to 60KB; env override wins; garbage falls back', () => {
    delete process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH
    expect(getOtelContentMaxLength()).toBe(60 * 1024)
    process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = '2048'
    expect(getOtelContentMaxLength()).toBe(2048)
    process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = 'lots'
    expect(getOtelContentMaxLength()).toBe(60 * 1024)
    process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = '0'
    expect(getOtelContentMaxLength()).toBe(60 * 1024)
  })

  test('truncates over-limit content with a limit-accurate marker', () => {
    process.env.CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH = '1024'
    const { content, truncated } = truncateContent('x'.repeat(2000))
    expect(truncated).toBe(true)
    expect(content).toContain('[TRUNCATED - Content exceeds 1KB limit]')
    expect(content.startsWith('x'.repeat(1024))).toBe(true)

    const short = truncateContent('hello')
    expect(short).toEqual({ content: 'hello', truncated: false })
  })
})
