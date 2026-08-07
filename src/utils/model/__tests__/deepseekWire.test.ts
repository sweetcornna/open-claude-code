import { afterEach, describe, expect, test } from 'bun:test'
import {
  applyDeepSeekAnthropicWire,
  getDeepSeekAnthropicBaseURL,
  isDeepSeekAnthropicWireActive,
  isDeepSeekMirroredApiKey,
} from '../deepseekWire.js'

/**
 * DeepSeek is configured through the OPENAI_* keys but is routed to its
 * Anthropic-compatible endpoint, because that is the only one of its three
 * protocols that gives occ native thinking blocks, no lossy format conversion,
 * and a server-side web_search the first-party search adapter already asks for.
 */

const TOUCHED = [
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
  'OPENAI_DEFAULT_HAIKU_MODEL',
  'OPENAI_DEFAULT_SONNET_MODEL',
  'OPENAI_DEFAULT_OPUS_MODEL',
  'OPENAI_DEFAULT_FABLE_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_FABLE_MODEL',
  'CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE',
] as const

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key]
})

/** The shape a DeepSeek user's settings.json actually produces. */
function deepseekEnv(): void {
  process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
  process.env.OPENAI_API_KEY = 'sk-test'
}

describe('isDeepSeekAnthropicWireActive', () => {
  test('active for a DeepSeek base URL with a key', () => {
    deepseekEnv()
    expect(isDeepSeekAnthropicWireActive()).toBe(true)
  })

  test('inactive for any other OpenAI-compatible endpoint', () => {
    process.env.OPENAI_BASE_URL =
      'https://ark.cn-beijing.volces.com/api/coding/v3'
    process.env.OPENAI_API_KEY = 'ark-test'
    // Ark has no Anthropic line at all (404), and its /responses web_search is
    // accepted but never executed. Detection is by host for exactly this reason.
    expect(isDeepSeekAnthropicWireActive()).toBe(false)
  })

  test('inactive without a key — a silent 401 is worse than the old path', () => {
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com'
    expect(isDeepSeekAnthropicWireActive()).toBe(false)
  })

  test('an explicit OPENAI_WIRE_API wins', () => {
    deepseekEnv()
    for (const wire of ['chat', 'responses', 'CHAT', ' responses ']) {
      process.env.OPENAI_WIRE_API = wire
      expect(isDeepSeekAnthropicWireActive()).toBe(false)
    }
  })

  test('the opt-out env forces the old path', () => {
    deepseekEnv()
    for (const value of ['0', 'false', 'FALSE']) {
      process.env.CLAUDE_CODE_DEEPSEEK_ANTHROPIC_WIRE = value
      expect(isDeepSeekAnthropicWireActive()).toBe(false)
    }
  })

  test('yields to an ANTHROPIC_BASE_URL pointing somewhere else', () => {
    deepseekEnv()
    process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
    expect(isDeepSeekAnthropicWireActive()).toBe(false)
  })

  test('stays active after apply() wrote ANTHROPIC_BASE_URL', () => {
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    // A naive "is ANTHROPIC_BASE_URL set?" guard would make this false and the
    // provider arm would flip mid-session.
    expect(isDeepSeekAnthropicWireActive()).toBe(true)
  })
})

describe('getDeepSeekAnthropicBaseURL', () => {
  test('appends the /anthropic path', () => {
    deepseekEnv()
    expect(getDeepSeekAnthropicBaseURL()).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })

  test('tolerates a trailing slash and does not double the suffix', () => {
    process.env.OPENAI_API_KEY = 'sk-test'
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/'
    expect(getDeepSeekAnthropicBaseURL()).toBe(
      'https://api.deepseek.com/anthropic',
    )
    process.env.OPENAI_BASE_URL = 'https://api.deepseek.com/anthropic'
    expect(getDeepSeekAnthropicBaseURL()).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })

  test('undefined when the routing is not active', () => {
    expect(getDeepSeekAnthropicBaseURL()).toBeUndefined()
  })
})

describe('applyDeepSeekAnthropicWire', () => {
  test('mirrors base URL, key and tier models onto the ANTHROPIC_* keys', () => {
    deepseekEnv()
    process.env.OPENAI_DEFAULT_HAIKU_MODEL = 'deepseek-v4-flash'
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'

    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test')
    // The user's explicit tier choice must outrank DeepSeek's own alias
    // mapping (claude-opus* → v4-pro, claude-sonnet*/haiku* → v4-flash).
    expect(process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('deepseek-v4-flash')
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-pro')
  })

  test('never overwrites a value the user already set on the Anthropic side', () => {
    deepseekEnv()
    process.env.ANTHROPIC_API_KEY = 'sk-mine'
    process.env.OPENAI_DEFAULT_OPUS_MODEL = 'deepseek-v4-pro'
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = 'deepseek-v4-flash'

    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-mine')
    expect(process.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('deepseek-v4-flash')
  })

  test('carries OPENAI_MODEL across as the pinned model', () => {
    deepseekEnv()
    process.env.OPENAI_MODEL = 'deepseek-v4-pro'

    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_MODEL).toBe('deepseek-v4-pro')
  })

  test('is a no-op for a non-DeepSeek endpoint', () => {
    process.env.OPENAI_BASE_URL = 'https://api.openai.com/v1'
    process.env.OPENAI_API_KEY = 'sk-openai'

    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('is idempotent', () => {
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    )
  })
})

/**
 * The mirror runs at startup, but the configuration it mirrors can arrive
 * later — a first `/login` writes the DeepSeek keys into a process that booted
 * without them. `getAPIProvider()` flips to 'firstParty' the instant those keys
 * land, so a mirror that does not run again leaves the session claiming the
 * routing without applying it: requests go to api.anthropic.com with no
 * credential and come back "Not logged in · Please run /login", while the tier
 * aliases resolve to a literal `claude-sonnet-5`.
 */
describe('following configuration that changes mid-session', () => {
  test('a first login applies the routing that startup could not', () => {
    // Boot with nothing configured: no key, so the mirror is a no-op.
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()

    // /login writes the provider env, then re-applies.
    deepseekEnv()
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'deepseek-v4-flash'
    applyDeepSeekAnthropicWire()

    expect(process.env.ANTHROPIC_BASE_URL).toBe(
      'https://api.deepseek.com/anthropic',
    )
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-flash')
  })

  test('a changed tier model replaces the previous mirror', () => {
    deepseekEnv()
    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'deepseek-v4-flash'
    applyDeepSeekAnthropicWire()

    process.env.OPENAI_DEFAULT_SONNET_MODEL = 'deepseek-v4-pro'
    applyDeepSeekAnthropicWire()

    // Fill-the-blanks would have kept v4-flash here forever.
    expect(process.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('deepseek-v4-pro')
  })

  test('switching provider away releases the mirror', () => {
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_BASE_URL).toBeDefined()

    delete process.env.OPENAI_BASE_URL
    delete process.env.OPENAI_API_KEY
    applyDeepSeekAnthropicWire()

    // Leaving them behind would keep pointing the first-party client at
    // DeepSeek with a key the user just stopped using.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('a mirrored key is recognisable as occ-configured', () => {
    // The interactive auth path only accepts an ANTHROPIC_API_KEY from the
    // environment when the user approved it. A mirrored key was never
    // "found in the environment" — occ copied it from the provider key the
    // user typed into /login — so there is no prompt they could have answered,
    // and the approval dialog defaults to "No (recommended)". Answering the
    // default rejects the key they just configured and the REPL reports
    // "Not logged in · Please run /login" while --print keeps working.
    deepseekEnv()
    applyDeepSeekAnthropicWire()

    expect(isDeepSeekMirroredApiKey(process.env.ANTHROPIC_API_KEY)).toBe(true)
    expect(isDeepSeekMirroredApiKey('sk-something-else')).toBe(false)
    expect(isDeepSeekMirroredApiKey(undefined)).toBe(false)
  })

  test('a key occ did not write is not reported as mirrored', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-user-owned'
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    // The mirror leaves a user-owned key alone, so it must not vouch for it
    // either — that key still belongs in the approval flow.
    expect(isDeepSeekMirroredApiKey('sk-ant-user-owned')).toBe(false)
  })

  test('releasing the mirror withdraws the vouch', () => {
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    const mirrored = process.env.ANTHROPIC_API_KEY

    delete process.env.OPENAI_BASE_URL
    applyDeepSeekAnthropicWire()

    expect(isDeepSeekMirroredApiKey(mirrored)).toBe(false)
  })

  test('a key the user set themselves is never claimed or removed', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-user-owned'
    deepseekEnv()
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-user-owned')

    delete process.env.OPENAI_BASE_URL
    applyDeepSeekAnthropicWire()
    expect(process.env.ANTHROPIC_API_KEY).toBe('sk-ant-user-owned')
  })
})
