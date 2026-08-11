/**
 * No mocks: opencodeWire reads process.env and nothing else, which is the
 * property that keeps it off the dependency cycle getAPIProvider() sits on.
 * Mocking anything here would only hide a regression in that property.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyOpencodeWire,
  getOpencodeLane,
  isOpencodeMirroredApiKey,
  isOpencodeSessionActive,
  laneForModel,
  setOpencodeRuntimeCredential,
} from '../opencodeWire.js'

const MANAGED = [
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_MODEL',
  'OPENCODE_WIRE_API',
  'OPENCODE_DEFAULT_HAIKU_MODEL',
  'OPENCODE_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
] as const

const saved = new Map<string, string | undefined>()
for (const key of MANAGED) saved.set(key, process.env[key])

function configure(env: Record<string, string | undefined>): void {
  for (const key of MANAGED) delete process.env[key]
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) process.env[key] = value
  }
}

afterEach(() => {
  setOpencodeRuntimeCredential(undefined)
  applyOpencodeWire()
  for (const key of MANAGED) {
    const value = saved.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

const ZEN = 'https://opencode.ai/zen/v1'

describe('laneForModel', () => {
  test('claude ids take the Anthropic Messages lane', () => {
    expect(laneForModel('claude-opus-5')).toBe('messages')
    expect(laneForModel('claude-haiku-4-5')).toBe('messages')
    expect(laneForModel('claude-fable-5')).toBe('messages')
  })

  test('GPT and the o-series take the Responses lane', () => {
    expect(laneForModel('gpt-5.6-sol')).toBe('responses')
    expect(laneForModel('gpt-5.3-codex')).toBe('responses')
    expect(laneForModel('o3-mini')).toBe('responses')
  })

  test('everything else falls to Chat Completions', () => {
    for (const model of [
      'gemini-3.6-flash',
      'deepseek-v4-pro',
      'glm-5.2',
      'kimi-k3',
      'grok-4.5',
      'big-pickle',
    ]) {
      expect(laneForModel(model)).toBe('chat')
    }
  })
})

describe('getOpencodeLane', () => {
  test('is undefined when the session is not an OpenCode session', () => {
    configure({ OPENCODE_MODEL: 'claude-opus-5' })
    expect(isOpencodeSessionActive()).toBe(false)
    expect(getOpencodeLane()).toBeUndefined()
  })

  test('follows the configured model', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_MODEL: 'claude-opus-5',
    })
    expect(getOpencodeLane()).toBe('messages')
  })

  test('an explicit OPENCODE_WIRE_API wins over the heuristic', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_MODEL: 'claude-opus-5',
      OPENCODE_WIRE_API: 'chat',
    })
    expect(getOpencodeLane()).toBe('chat')
  })
})

describe('applyOpencodeWire', () => {
  test('mirrors a claude session onto the Anthropic keys', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
      OPENCODE_DEFAULT_HAIKU_MODEL: 'claude-haiku-4-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBe(ZEN)
    expect(process.env.ANTHROPIC_API_KEY).toBe('tok-live')
    // NOT ANTHROPIC_AUTH_TOKEN. The SDK turns `apiKey` into `x-api-key` and
    // `authToken` into `Authorization: Bearer`, and Zen's /messages lane
    // accepts only the former — verified against the live endpoint: Bearer
    // alone answers `AuthError: Missing API key`. Writing the wrong one 401s
    // every OpenCode Claude session, which is invisible to a test that only
    // checks "some credential env key was set".
    expect(process.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-opus-5')
    expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5')
    // The OpenAI lane must stay untouched, or a later provider switch inherits
    // a base URL nobody configured.
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })

  test('mirrors a GPT session onto the OpenAI keys with the Responses wire', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'gpt-5.6-sol',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    expect(process.env.OPENAI_BASE_URL).toBe(ZEN)
    expect(process.env.OPENAI_WIRE_API).toBe('responses')
    expect(process.env.OPENAI_API_KEY).toBe('tok-live')
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  test('non-GPT third-party models get the chat wire', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'kimi-k3',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    expect(process.env.OPENAI_WIRE_API).toBe('chat')
  })

  test('re-applying after a model change releases the previous lane', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()
    expect(process.env.ANTHROPIC_BASE_URL).toBe(ZEN)

    process.env.OPENCODE_MODEL = 'gpt-5.6-sol'
    applyOpencodeWire()

    // Switching lanes must not leave the Anthropic endpoint behind: a stale
    // ANTHROPIC_BASE_URL is exactly what makes a later first-party session post
    // to somebody else's host.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.OPENAI_BASE_URL).toBe(ZEN)
  })

  test('never overwrites a value the user set themselves', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
      ANTHROPIC_API_KEY: 'user-owned',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    expect(process.env.ANTHROPIC_API_KEY).toBe('user-owned')
  })

  test('a value replaced by something else is not reclaimed on release', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    // Something authoritative overwrites the mirrored key.
    process.env.ANTHROPIC_API_KEY = 'reapplied-by-settings'
    delete process.env.OPENCODE_AUTH_MODE
    applyOpencodeWire()

    expect(process.env.ANTHROPIC_API_KEY).toBe('reapplied-by-settings')
  })

  test('vouches for its own mirrored key, and only that value', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    // isOccConfiguredAnthropicApiKey() consults this so the interactive
    // "Detected a custom API key" prompt is skipped for a value occ mirrored
    // itself. Answering that prompt's default (No) rejects the credential the
    // user just logged in with, and the session reports "Not logged in".
    expect(isOpencodeMirroredApiKey('tok-live')).toBe(true)
    expect(isOpencodeMirroredApiKey('some-other-key')).toBe(false)
    expect(isOpencodeMirroredApiKey(undefined)).toBe(false)
  })

  test('stops vouching once the mirror is released', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_BASE_URL: ZEN,
      OPENCODE_MODEL: 'claude-opus-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()
    expect(isOpencodeMirroredApiKey('tok-live')).toBe(true)

    delete process.env.OPENCODE_AUTH_MODE
    applyOpencodeWire()

    // Otherwise a key this module no longer owns keeps its approval bypass.
    expect(isOpencodeMirroredApiKey('tok-live')).toBe(false)
  })

  test('does nothing without a base URL', () => {
    configure({
      OPENCODE_AUTH_MODE: 'opencode',
      OPENCODE_MODEL: 'claude-opus-5',
    })
    setOpencodeRuntimeCredential('tok-live')
    applyOpencodeWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
