/**
 * `getProxyUrl` precedence, including the CLAUDE_CODE_-prefixed fallbacks.
 *
 * The function already takes the env as a parameter, so no process.env
 * mutation and no module mocking is needed.
 */
import { describe, expect, test } from 'bun:test'
import { getProxyUrl } from '../proxy.js'

describe('getProxyUrl', () => {
  test('returns undefined when nothing is configured', () => {
    expect(getProxyUrl({})).toBeUndefined()
  })

  test('standard names keep their existing precedence', () => {
    const all = {
      https_proxy: 'http://a:1',
      HTTPS_PROXY: 'http://b:1',
      http_proxy: 'http://c:1',
      HTTP_PROXY: 'http://d:1',
    }
    expect(getProxyUrl(all)).toBe('http://a:1')
    expect(getProxyUrl({ ...all, https_proxy: undefined })).toBe('http://b:1')
    expect(
      getProxyUrl({ ...all, https_proxy: undefined, HTTPS_PROXY: undefined }),
    ).toBe('http://c:1')
  })

  test('CLAUDE_CODE_HTTPS_PROXY is honored when no standard name is set', () => {
    expect(getProxyUrl({ CLAUDE_CODE_HTTPS_PROXY: 'http://occ:8080' })).toBe(
      'http://occ:8080',
    )
    expect(getProxyUrl({ CLAUDE_CODE_HTTP_PROXY: 'http://occ:8081' })).toBe(
      'http://occ:8081',
    )
  })

  test('CLAUDE_CODE_HTTPS_PROXY outranks CLAUDE_CODE_HTTP_PROXY', () => {
    expect(
      getProxyUrl({
        CLAUDE_CODE_HTTP_PROXY: 'http://plain:1',
        CLAUDE_CODE_HTTPS_PROXY: 'http://secure:1',
      }),
    ).toBe('http://secure:1')
  })

  test('the prefixed names are lowest priority — a standard name always wins', () => {
    expect(
      getProxyUrl({
        HTTP_PROXY: 'http://standard:1',
        CLAUDE_CODE_HTTPS_PROXY: 'http://prefixed:1',
      }),
    ).toBe('http://standard:1')
  })
})
