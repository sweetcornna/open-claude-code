/**
 * The rule the OpenCode Console login exists to enforce: a sign-in that cannot
 * be used must leave nothing behind.
 *
 * This is the regression guard for a measured failure. A device login completed
 * against a product the account could not use, and occ activated it anyway:
 * settings.json got `modelType: "opencode"` plus the endpoint, the mirror
 * published the OPENAI_* keys, the model picker offered the product's real
 * catalog (both products serve `GET /models` with no credential), and the first
 * prompt came back `API Error [OpenAI]: Invalid API key`. Nothing on that path
 * ever exercised the token, so the failure looked like a broken provider.
 *
 * Driven through the real settings layer against a scratch OCC_CONFIG_DIR —
 * asserting "no write happened" against a mock of the writer would only pin the
 * mock. Only log/debug leaves are mock.module'd, per CLAUDE.md.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const GO = 'https://opencode.ai/zen/go/v1'
const OCC = 'OCC_CONFIG_DIR'

let activate: typeof import('../activateSession.js')
let settingsCache: typeof import('src/utils/settings/settingsCache.js')
let dir: string
const previousConfigDir = process.env[OCC]
/** Provider keys this suite writes; restored so no later file inherits them. */
const TOUCHED = [
  'OPENCODE_AUTH_MODE',
  'OPENCODE_BASE_URL',
  'OPENCODE_INFERENCE_PLANE',
  'OPENCODE_API_KEY',
  'OPENCODE_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_WIRE_API',
  'OPENAI_MODEL',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
] as const
const savedEnv = new Map<string, string | undefined>()

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'occ-opencode-activate-'))
  process.env[OCC] = dir
  for (const key of TOUCHED) {
    savedEnv.set(key, process.env[key])
    delete process.env[key]
  }
  activate = await import('../activateSession.js')
  settingsCache = await import('src/utils/settings/settingsCache.js')
})

afterAll(() => {
  if (previousConfigDir === undefined) delete process.env[OCC]
  else process.env[OCC] = previousConfigDir
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function resetConfigDir(): void {
  writeFileSync(
    join(dir, 'settings.json'),
    `${JSON.stringify({ env: {} }, null, 2)}\n`,
  )
  settingsCache.resetSettingsCache()
  for (const key of TOUCHED) delete process.env[key]
}

afterEach(resetConfigDir)

function onDisk(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

describe('a credential the endpoint refuses', () => {
  test('activates nothing at all', () => {
    resetConfigDir()
    const result = activate.activateOpencodeConsoleSession({
      baseUrl: GO,
      label: 'OpenCode Go',
      otherLabel: 'OpenCode Zen',
      accessToken: 'access-token',
      access: { ok: false, reason: 'Invalid API key.' },
    })

    expect(result.activated).toBe(false)
    // settings.json: untouched. `modelType: "opencode"` alone is enough to make
    // /models-setting, /provider save and the status line all report a session
    // that cannot answer a single request.
    expect(onDisk()).toEqual({ env: {} })
    // process.env: untouched. OPENCODE_AUTH_MODE is the sole basis of
    // isOpencodeSessionActive(), which getAPIProvider() consults — setting it
    // routes the whole session at an endpoint it has no credential for.
    for (const key of TOUCHED) expect(process.env[key]).toBeUndefined()
  })

  test('says which product refused, and where to go next', () => {
    resetConfigDir()
    const result = activate.activateOpencodeConsoleSession({
      baseUrl: GO,
      label: 'OpenCode Go',
      otherLabel: 'OpenCode Zen',
      accessToken: 'access-token',
      access: { ok: false, reason: 'Invalid API key.' },
    })
    if (result.activated) throw new Error('expected a refusal')

    // "Invalid API key" on its own is actively misleading after a browser
    // sign-in: there is no key, the sign-in worked, and the two products are
    // one path segment apart.
    expect(result.message).toContain('OpenCode Go')
    expect(result.message).toContain(GO)
    expect(result.message).toContain('OpenCode Zen')
    expect(result.message).toContain('Nothing was configured')
  })
})

describe('a credential the endpoint accepts', () => {
  test('activates the session it was verified against', () => {
    resetConfigDir()
    const result = activate.activateOpencodeConsoleSession({
      baseUrl: GO,
      label: 'OpenCode Go',
      otherLabel: 'OpenCode Zen',
      accessToken: 'access-token',
      access: { ok: true },
    })

    expect(result.activated).toBe(true)
    expect(onDisk()).toEqual({
      env: { OPENCODE_AUTH_MODE: 'opencode', OPENCODE_BASE_URL: GO },
      modelType: 'opencode',
    })
    expect(process.env.OPENCODE_AUTH_MODE).toBe('opencode')
    expect(process.env.OPENCODE_BASE_URL).toBe(GO)
    // The mirror ran: without it the session claims OpenCode routing it never
    // applied, and requests leave for the previous provider's host.
    expect(process.env.OPENAI_BASE_URL).toBe(GO)
    expect(process.env.OPENAI_API_KEY).toBe('access-token')
  })

  test('the access token never reaches settings.json', () => {
    resetConfigDir()
    activate.activateOpencodeConsoleSession({
      baseUrl: GO,
      label: 'OpenCode Go',
      otherLabel: 'OpenCode Zen',
      accessToken: 'access-token',
      access: { ok: true },
    })
    // It expires within the hour and is a secret in a plain config file; the
    // 0600 credential store is the only place it belongs.
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).not.toContain(
      'access-token',
    )
  })
})

/**
 * The other session kind. A Console token is not a credential for either
 * product — measured on one account, side by side: 200 at
 * `config.provider.opencode.api`, 401 `AuthError: Invalid API key.` at
 * https://opencode.ai/zen/v1 — so the endpoint written here is the one
 * `/api/config` named, and the plane marker is what stops the lane heuristic
 * from aiming a `claude-*` session at a `/messages` path that answers 404.
 */
const CONSOLE = 'https://console.opencode.ai/inference/openai/v1'

describe('a Console-plane session', () => {
  test('is configured at the endpoint the console named, on the chat lane', () => {
    resetConfigDir()
    // A claude id: on Zen this is precisely what routes to /messages.
    process.env.OPENCODE_MODEL = 'claude-opus-5'
    const result = activate.activateOpencodeConsoleSession({
      baseUrl: CONSOLE,
      label: 'OpenCode Zen',
      otherLabel: 'OpenCode Go',
      accessToken: 'access-token',
      plane: 'console',
      access: { ok: true },
    })

    expect(result.activated).toBe(true)
    expect(onDisk()).toEqual({
      env: {
        OPENCODE_AUTH_MODE: 'opencode',
        OPENCODE_BASE_URL: CONSOLE,
        OPENCODE_INFERENCE_PLANE: 'console',
      },
      modelType: 'opencode',
    })
    // The mirror published the console endpoint on the OpenAI keys…
    expect(process.env.OPENAI_BASE_URL).toBe(CONSOLE)
    expect(process.env.OPENAI_WIRE_API).toBe('chat')
    expect(process.env.OPENAI_API_KEY).toBe('access-token')
    // …and nothing at all on the Anthropic ones. This is the bug: a `claude-*`
    // model here used to point the Anthropic client at the base URL and speak
    // /messages, which that plane does not serve.
    expect(process.env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
  })

  test('a refusal does not offer the other product — there is no other product', () => {
    resetConfigDir()
    const result = activate.activateOpencodeConsoleSession({
      baseUrl: CONSOLE,
      label: 'OpenCode Zen',
      otherLabel: 'OpenCode Go',
      accessToken: 'access-token',
      plane: 'console',
      access: { ok: false, reason: 'Invalid API key.' },
    })
    if (result.activated) throw new Error('expected a refusal')

    // The Zen/Go sentence is about two separately-billed products one path
    // segment apart. The console's own inference proxy is neither of them, and
    // telling a refused Console user to "pick OpenCode Go instead" is advice
    // about a bill they are not on.
    expect(result.message).toContain(CONSOLE)
    expect(result.message).not.toContain('OpenCode Go')
    expect(result.message).toContain('Nothing was configured')
    expect(onDisk()).toEqual({ env: {} })
  })

  test('an API-key session gets no plane marker', () => {
    resetConfigDir()
    activate.activateOpencodeConsoleSession({
      baseUrl: 'https://opencode.ai/zen/go/v1',
      label: 'OpenCode Go',
      otherLabel: 'OpenCode Zen',
      accessToken: 'access-token',
      access: { ok: true },
    })
    // Absence is the Zen/Go kind. A marker left on would force every model onto
    // /chat/completions and pin the base URL semantics of a different plane.
    expect(process.env.OPENCODE_INFERENCE_PLANE).toBeUndefined()
    expect(onDisk()).toEqual({
      env: {
        OPENCODE_AUTH_MODE: 'opencode',
        OPENCODE_BASE_URL: 'https://opencode.ai/zen/go/v1',
      },
      modelType: 'opencode',
    })
  })
})
