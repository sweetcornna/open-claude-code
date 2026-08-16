import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_REMOTE_CONTROL_URL } from '../../constants/brand.js'
import { getOauthConfig } from '../../constants/oauth.js'
import {
  getBridgeBaseUrlOverride,
  normalizeBridgeBaseUrl,
  resolveBridgeBaseUrl,
  resolveBridgeSessionIngressUrl,
} from '../bridgeBaseUrl.js'
import {
  getBridgeBaseUrl,
  isSelfHostedBridge,
  shouldBlockBridgeStartupForLogin,
} from '../bridgeConfig.js'

// Every key the resolver reads. Anything asserted absent has to be cleared
// here, or the assertion silently reads the developer's own shell instead.
const ENV_KEYS = [
  'OCC_REMOTE_CONTROL_URL',
  'CLAUDE_BRIDGE_BASE_URL',
  'CLAUDE_BRIDGE_SESSION_INGRESS_URL',
  'CLAUDE_BRIDGE_OAUTH_TOKEN',
] as const
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key]
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
})

describe('remote control base URL resolution', () => {
  test('defaults to the public occ Remote Control server', () => {
    expect(getBridgeBaseUrlOverride()).toBeUndefined()
    expect(resolveBridgeBaseUrl()).toBe(DEFAULT_REMOTE_CONTROL_URL)
    expect(getBridgeBaseUrl()).toBe(DEFAULT_REMOTE_CONTROL_URL)
  })

  test('OCC_REMOTE_CONTROL_URL wins over CLAUDE_BRIDGE_BASE_URL', () => {
    process.env.OCC_REMOTE_CONTROL_URL = 'https://new.example.test'
    process.env.CLAUDE_BRIDGE_BASE_URL = 'https://old.example.test'
    expect(resolveBridgeBaseUrl()).toBe('https://new.example.test')
  })

  // The maintainer's own settings.json still carries the old key, and it is
  // the documented form for every existing self-hosted deployment.
  test('CLAUDE_BRIDGE_BASE_URL is still honoured on its own', () => {
    process.env.CLAUDE_BRIDGE_BASE_URL = 'https://old.example.test'
    expect(resolveBridgeBaseUrl()).toBe('https://old.example.test')
  })

  test('normalizes trailing slashes and surrounding whitespace', () => {
    process.env.OCC_REMOTE_CONTROL_URL = '  https://rcs.example.test///  '
    expect(resolveBridgeBaseUrl()).toBe('https://rcs.example.test')
    expect(normalizeBridgeBaseUrl('https://x.test/')).toBe('https://x.test')
  })

  test('an empty or slash-only value falls through to the next source', () => {
    process.env.OCC_REMOTE_CONTROL_URL = ''
    process.env.CLAUDE_BRIDGE_BASE_URL = '   '
    expect(getBridgeBaseUrlOverride()).toBeUndefined()
    expect(resolveBridgeBaseUrl()).toBe(DEFAULT_REMOTE_CONTROL_URL)
  })

  test('session ingress defaults to the resolved base, override wins', () => {
    expect(resolveBridgeSessionIngressUrl(resolveBridgeBaseUrl())).toBe(
      DEFAULT_REMOTE_CONTROL_URL,
    )
    process.env.CLAUDE_BRIDGE_SESSION_INGRESS_URL = 'https://ingress.test/'
    expect(resolveBridgeSessionIngressUrl(resolveBridgeBaseUrl())).toBe(
      'https://ingress.test',
    )
  })
})

describe('isSelfHostedBridge', () => {
  // The inversion that makes Remote Control work out of the box: with no env
  // at all occ is on its own server, not on a claude.ai bridge it can never
  // pass the entitlement check for.
  test('is true by default', () => {
    expect(isSelfHostedBridge()).toBe(true)
  })

  test('is true for any configured server', () => {
    process.env.CLAUDE_BRIDGE_BASE_URL = 'http://127.0.0.1:59999'
    expect(isSelfHostedBridge()).toBe(true)
  })

  test('is false only when pointed at the official API base', () => {
    process.env.OCC_REMOTE_CONTROL_URL = getOauthConfig().BASE_API_URL
    expect(isSelfHostedBridge()).toBe(false)
  })

  test('is false for the official API base written with a trailing slash', () => {
    process.env.CLAUDE_BRIDGE_BASE_URL = `${getOauthConfig().BASE_API_URL}/`
    expect(isSelfHostedBridge()).toBe(false)
  })
})

describe('persistent remote-control startup gate', () => {
  test('blocks the official service when no credential is present', () => {
    expect(
      shouldBlockBridgeStartupForLogin({
        selfHosted: false,
        hasCredential: () => false,
      }),
    ).toBe(true)
  })

  test('lets the official service through once a credential exists', () => {
    expect(
      shouldBlockBridgeStartupForLogin({
        selfHosted: false,
        hasCredential: () => true,
      }),
    ).toBe(false)
  })

  // Regression: `occ remote-control` against an account-mode server used to
  // exit with the claude.ai login error before bridgeMain ever ran. A fresh
  // process legitimately holds no access token at that point — bridgeMain
  // obtains one from the stored refresh credential or the masked TTY prompt —
  // so the gate here must defer instead of refusing. Now that the default is
  // an account server, this is the path every unconfigured user takes.
  test('never blocks an account server, and does not even look for a credential', () => {
    expect(isSelfHostedBridge()).toBe(true)

    let credentialLookups = 0
    const blocked = shouldBlockBridgeStartupForLogin({
      selfHosted: isSelfHostedBridge(),
      hasCredential: () => {
        credentialLookups++
        return false
      },
    })

    expect(blocked).toBe(false)
    // Resolving the credential can spawn a keychain helper; the branch that
    // ignores the answer must not pay for it.
    expect(credentialLookups).toBe(0)
  })
})
