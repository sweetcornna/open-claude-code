import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { saveOpencodeTokens } from 'src/services/auth/opencode/store.js'
import { _resetOpencodeRefreshStateForTesting } from 'src/services/auth/opencode/oauth.js'
import {
  ensureOpencodeCredential,
  resetOpencodeCredentialCache,
} from '../opencodeCredential.js'

/**
 * The async half of the OpenCode routing, against a real credential file.
 *
 * No mocks: the store writes and reads a 0600 JSON file under occConfigDir(),
 * and pointing OCC_CONFIG_DIR at a temp dir exercises the whole path — which is
 * the point, because the failure this guards is "the mirror published nothing
 * because the credential layer was never asked", and a mocked credential layer
 * cannot express it.
 */

const ZEN = 'https://opencode.ai/zen/v1'

const ENV = [
  'OCC_CONFIG_DIR',
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_INFERENCE_PLANE',
  'OPENCODE_MODEL',
  'OPENCODE_WIRE_API',
  'OPENCODE_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENAI_WIRE_API',
] as const
const saved = Object.fromEntries(ENV.map(key => [key, process.env[key]]))

let tempDir: string | undefined

/** An hour out, so getOpencodeCredential() never reaches the refresh network. */
function notExpiring(): number {
  return Date.now() + 60 * 60_000
}

beforeEach(() => {
  for (const key of ENV) delete process.env[key]
  tempDir = mkdtempSync(join(tmpdir(), 'occ-opencode-cred-'))
  process.env.OCC_CONFIG_DIR = tempDir
  process.env.OPENCODE_BASE_URL = ZEN
})

afterEach(() => {
  // Release the mirror and the module-level token before restoring env, so a
  // failed assertion cannot leave this file's bearer token mirrored onto
  // ANTHROPIC_API_KEY for the rest of the shard.
  resetOpencodeCredentialCache()
  _resetOpencodeRefreshStateForTesting()
  for (const key of ENV) {
    const value = saved[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

describe('ensureOpencodeCredential', () => {
  test('is inert when the session is not OpenCode', async () => {
    process.env.OPENCODE_API_KEY = 'zen-key'
    // No OPENCODE_AUTH_MODE.
    expect(await ensureOpencodeCredential()).toBeUndefined()
    expect(process.env.OPENAI_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('an env API key reaches the OpenAI lane keys', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'gpt-5.6-codex'
    process.env.OPENCODE_API_KEY = 'zen-key'

    expect(await ensureOpencodeCredential()).toEqual({
      authorization: 'Bearer zen-key',
    })
    expect(process.env.OPENAI_BASE_URL).toBe(ZEN)
    expect(process.env.OPENAI_API_KEY).toBe('zen-key')
    expect(process.env.OPENAI_WIRE_API).toBe('responses')
  })

  test('a stored OAuth token reaches the Anthropic lane keys', async () => {
    // The failure without this: the mirror runs at startup with no token to
    // publish, so ANTHROPIC_API_KEY stays unset, the request goes out
    // unauthenticated and comes back 401 "Not logged in".
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    await saveOpencodeTokens({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: notExpiring(),
      server: 'https://console.opencode.ai',
      orgId: 'org-42',
    })

    expect(await ensureOpencodeCredential()).toEqual({
      authorization: 'Bearer access-1',
      'x-org-id': 'org-42',
    })
    expect(process.env.ANTHROPIC_BASE_URL).toBe(ZEN)
    expect(process.env.ANTHROPIC_API_KEY).toBe('access-1')
    expect(process.env.ANTHROPIC_MODEL).toBe('claude-opus-5')
  })

  test('an explicit OPENCODE_API_KEY outranks a stored login', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_API_KEY = 'zen-key'
    await saveOpencodeTokens({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: notExpiring(),
      server: 'https://console.opencode.ai',
    })

    expect(await ensureOpencodeCredential()).toEqual({
      authorization: 'Bearer zen-key',
    })
    expect(process.env.ANTHROPIC_API_KEY).toBe('zen-key')
  })

  test('an OpenCode session with nothing configured mirrors no credential', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'

    // Publishing nothing is the right answer — the endpoint half of the mirror
    // is applyOpencodeWire()'s job and the clients call it separately, so a
    // request still reaches Zen and fails with Zen's own 401 rather than
    // silently going to api.anthropic.com.
    expect(await ensureOpencodeCredential()).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('a rotated token replaces the mirrored one', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_API_KEY = 'zen-key-1'
    await ensureOpencodeCredential()
    expect(process.env.ANTHROPIC_API_KEY).toBe('zen-key-1')

    process.env.OPENCODE_API_KEY = 'zen-key-2'
    await ensureOpencodeCredential()
    expect(process.env.ANTHROPIC_API_KEY).toBe('zen-key-2')
  })

  test('does not overwrite a credential the user set themselves', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_API_KEY = 'zen-key'
    process.env.ANTHROPIC_API_KEY = 'user-exported'

    await ensureOpencodeCredential()
    expect(process.env.ANTHROPIC_API_KEY).toBe('user-exported')
  })
})

/**
 * The Console plane, end to end through the real store and the real mirror.
 *
 * The bug this pins: a Console OAuth token was sent to a hard-coded Zen base
 * URL and every request answered `API Error [OpenAI]: Invalid API key.
 * status=401`. Measured on one account with one token (2026-08-11): 200 with a
 * real completion at `config.provider.opencode.api`, 401 `AuthError` at
 * https://opencode.ai/zen/v1. So the endpoint and the `x-org-id` header both
 * come from the account's own config and travel with the credential.
 */
describe('a Console-plane session', () => {
  const CONSOLE = 'https://console.opencode.ai/inference/openai/v1'

  async function storeConsoleLogin(): Promise<void> {
    await saveOpencodeTokens({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      expiresAt: notExpiring(),
      server: 'https://console.opencode.ai',
      orgId: 'org-from-orgs-api',
      inference: { api: CONSOLE, headers: { 'x-org-id': 'org_01KZ' } },
    })
  }

  test('targets the config-supplied URL and sends x-org-id', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_INFERENCE_PLANE = 'console'
    process.env.OPENCODE_BASE_URL = CONSOLE
    // A `claude-*` model, which on Zen is exactly what selects /messages.
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    await storeConsoleLogin()

    expect(await ensureOpencodeCredential()).toEqual({
      authorization: 'Bearer access-1',
      // Without it the request is not scoped to the organization. The console
      // states which one; occ's own pick from /api/orgs does not override it.
      'x-org-id': 'org_01KZ',
    })
    expect(process.env.OPENAI_BASE_URL).toBe(CONSOLE)
    expect(process.env.OPENAI_WIRE_API).toBe('chat')
    expect(process.env.OPENAI_API_KEY).toBe('access-1')
    // Never /messages: that path answers 404 on this plane.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('the credential’s endpoint outranks a stale settings copy', async () => {
    // An upgrade from the broken build leaves OPENCODE_BASE_URL naming Zen.
    // The 0600 file is the copy that came from the console, so it wins and the
    // session heals without a second login.
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_INFERENCE_PLANE = 'console'
    process.env.OPENCODE_BASE_URL = ZEN
    process.env.OPENCODE_MODEL = 'big-pickle'
    await storeConsoleLogin()

    await ensureOpencodeCredential()
    expect(process.env.OPENAI_BASE_URL).toBe(CONSOLE)
  })

  test('an API-key session keeps the Zen endpoint and the lane rules', async () => {
    // The other kind, side by side. A stored Console login is present and must
    // not leak its endpoint into a session the key owns.
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_BASE_URL = ZEN
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_API_KEY = 'zen-key'
    await storeConsoleLogin()

    expect(await ensureOpencodeCredential()).toEqual({
      authorization: 'Bearer zen-key',
    })
    expect(process.env.ANTHROPIC_BASE_URL).toBe(ZEN)
    expect(process.env.ANTHROPIC_API_KEY).toBe('zen-key')
    expect(process.env.OPENAI_BASE_URL).toBeUndefined()
  })
})

describe('resetOpencodeCredentialCache', () => {
  test('releases the keys the mirror claimed', async () => {
    process.env.OPENCODE_AUTH_MODE = 'opencode'
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    process.env.OPENCODE_API_KEY = 'zen-key'
    await ensureOpencodeCredential()
    expect(process.env.ANTHROPIC_API_KEY).toBe('zen-key')

    // What logout needs: the bearer token lives outside process.env, so
    // clearing settings and env alone leaves the logged-out account's token
    // being republished on the next apply.
    delete process.env.OPENCODE_AUTH_MODE
    resetOpencodeCredentialCache()

    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
  })
})
