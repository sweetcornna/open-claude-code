import { afterEach, describe, expect, test } from 'bun:test'
import {
  getFsImplementation,
  setFsImplementation,
  setOriginalFsImplementation,
} from '../../filesystem/fsOperations.js'
import {
  _clearLogWritersForTesting,
  _sanitizeLogTextForTesting,
  _writeLogRecordForTesting,
} from '../errorLogSink.js'

afterEach(() => {
  _clearLogWritersForTesting()
  setOriginalFsImplementation()
})

describe('error log credential sanitization', () => {
  test('removes URL userinfo/query/fragment and sensitive header fields', () => {
    const sanitized = _sanitizeLogTextForTesting(
      'HTTP transport options: {"url":"https://user:password@example.com/mcp?access_token=url-secret#fragment-secret","headers":{"Cookie":"cookie-secret","X-API-Key":"api-secret","X-Custom-Token":"custom-secret"}}',
    )

    expect(sanitized).toContain('https://example.com/mcp')
    expect(sanitized).not.toContain('password')
    expect(sanitized).not.toContain('url-secret')
    expect(sanitized).not.toContain('fragment-secret')
    expect(sanitized).not.toContain('cookie-secret')
    expect(sanitized).not.toContain('api-secret')
    expect(sanitized).not.toContain('custom-secret')
    expect(sanitized.match(/\[REDACTED\]/g)?.length).toBe(3)
  })
})

describe('error log write failures', () => {
  test('does not create a directory for non-ENOENT append failures', () => {
    const baseFs = getFsImplementation()
    let mkdirCalls = 0
    setFsImplementation({
      ...baseFs,
      appendFileSync: () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' })
      },
      mkdirSync: () => {
        mkdirCalls++
      },
    })

    expect(() =>
      _writeLogRecordForTesting('/tmp/occ-error-log-eacces.jsonl', {
        error: 'test',
      }),
    ).not.toThrow()
    expect(mkdirCalls).toBe(0)
  })

  test('swallows a failed retry after creating a missing directory', () => {
    const baseFs = getFsImplementation()
    let appendCalls = 0
    let mkdirCalls = 0
    setFsImplementation({
      ...baseFs,
      appendFileSync: () => {
        appendCalls++
        const code = appendCalls === 1 ? 'ENOENT' : 'EACCES'
        throw Object.assign(new Error(code), { code })
      },
      mkdirSync: () => {
        mkdirCalls++
      },
    })

    expect(() =>
      _writeLogRecordForTesting('/tmp/occ-error-log-retry.jsonl', {
        error: 'test',
      }),
    ).not.toThrow()
    expect(appendCalls).toBe(2)
    expect(mkdirCalls).toBe(1)
  })
})
