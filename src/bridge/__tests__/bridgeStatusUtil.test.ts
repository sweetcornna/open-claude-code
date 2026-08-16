import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { buildBridgeConnectUrl } from '../bridgeStatusUtil.js'

const savedBridgeBaseUrl = process.env.CLAUDE_BRIDGE_BASE_URL

beforeAll(() => {
  process.env.CLAUDE_BRIDGE_BASE_URL = 'http://127.0.0.1:43118/'
})

afterAll(() => {
  if (savedBridgeBaseUrl === undefined) {
    delete process.env.CLAUDE_BRIDGE_BASE_URL
  } else {
    process.env.CLAUDE_BRIDGE_BASE_URL = savedBridgeBaseUrl
  }
})

describe('buildBridgeConnectUrl', () => {
  test('opens the current session directly on a self-hosted server', () => {
    expect(
      buildBridgeConnectUrl('env_test', undefined, 'session_current'),
    ).toBe('http://127.0.0.1:43118/code/session_current')
  })

  test('keeps the environment connect URL when no session exists yet', () => {
    expect(buildBridgeConnectUrl('env_test')).toBe(
      'http://127.0.0.1:43118/code?bridge=env_test',
    )
  })
})
