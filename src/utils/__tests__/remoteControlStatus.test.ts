import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_REMOTE_CONTROL_URL } from '../../constants/brand'
import { getOauthConfig } from '../../constants/oauth'
import {
  getRemoteSessionUrl,
  setRemoteSessionUrl,
} from '../../constants/product'
import { createBridgeStatusMessage } from '../messages'
import { isLoggableMessage } from '../sessionStorage/entries'
import { formatRemoteControlLocalStatus } from '../network/remoteControlStatus'

// tests/preload.ts clears the Remote Control keys for the whole run, so each
// test only has to undo what it set. CLAUDE_BRIDGE_OAUTH_TOKEN is not in that
// list — a leftover value would make `token=missing` unassertable.
const savedToken = process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
delete process.env.CLAUDE_BRIDGE_OAUTH_TOKEN

afterEach(() => {
  delete process.env.OCC_REMOTE_CONTROL_URL
  delete process.env.CLAUDE_BRIDGE_BASE_URL
  if (savedToken === undefined) {
    delete process.env.CLAUDE_BRIDGE_OAUTH_TOKEN
  } else {
    process.env.CLAUDE_BRIDGE_OAUTH_TOKEN = savedToken
  }
})

describe('remote session URL', () => {
  test('prefers a server-issued single-use pairing URL', () => {
    const sessionId = 'session_local_pairing_url_test'
    const pairingUrl =
      'https://rc.example.test/code/session_local_pairing_url_test#pair=one-time'
    setRemoteSessionUrl(sessionId, pairingUrl)
    expect(getRemoteSessionUrl(sessionId)).toBe(pairingUrl)
    expect(isLoggableMessage(createBridgeStatusMessage(pairingUrl))).toBe(false)
  })

  // With no configuration the session lives on the default public server, not
  // on claude.ai — the URL printed in the terminal has to match the server the
  // bridge actually registered with.
  test('builds from the default server when nothing is configured', () => {
    expect(getRemoteSessionUrl('session_unconfigured')).toBe(
      `${DEFAULT_REMOTE_CONTROL_URL}/code/session_unconfigured`,
    )
  })

  test('builds from the configured server, trailing slash and all', () => {
    process.env.OCC_REMOTE_CONTROL_URL = 'https://rcs.example.test/'
    expect(getRemoteSessionUrl('session_configured')).toBe(
      'https://rcs.example.test/code/session_configured',
    )
  })

  test('falls back to claude.ai only for the official bridge', () => {
    process.env.OCC_REMOTE_CONTROL_URL = getOauthConfig().BASE_API_URL
    expect(getRemoteSessionUrl('session_official')).toBe(
      'https://claude.ai/code/session_official',
    )
  })
})

describe('remote control status', () => {
  test('names the default public server as the default, not as self-hosted', () => {
    const status = formatRemoteControlLocalStatus()

    expect(status).toContain('Remote Control: default (public server)')
    expect(status).toContain(`base_url=${DEFAULT_REMOTE_CONTROL_URL}`)
    // Deliberately no token assertion: with no account session the getter
    // falls through to the claude.ai keychain, whose answer depends on
    // whoever is running the suite.
  })

  test('formats self-hosted bridge local config without remote calls', () => {
    process.env.CLAUDE_BRIDGE_BASE_URL = 'http://127.0.0.1:8787'
    process.env.CLAUDE_BRIDGE_OAUTH_TOKEN = 'token'

    const status = formatRemoteControlLocalStatus()

    expect(status).toContain('Remote Control: self-hosted')
    expect(status).toContain('base_url=http://127.0.0.1:8787')
    expect(status).toContain('token=present')
    expect(status).toContain('entitlement=checked at remote-control startup')
  })

  test('names the official bridge when explicitly targeted', () => {
    process.env.OCC_REMOTE_CONTROL_URL = getOauthConfig().BASE_API_URL

    expect(formatRemoteControlLocalStatus()).toContain(
      'Remote Control: official (claude.ai)',
    )
  })
})
