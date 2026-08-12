/**
 * The property web search's copied logins exist for: an OAuth credential that
 * outlives `/logout`.
 *
 * Real files under a temporary OCC_CONFIG_DIR, and the real removal functions,
 * for the same reason the API-key half is tested that way: the two things worth
 * asserting are that a file survives a deletion and that a refresh lands in one
 * file rather than another, and neither survives being faked. `resetProvider
 * Configuration()` — the synchronous half of `/logout` — runs for real too, so
 * "the copy was untouched" is a statement about the code that actually runs on
 * logout rather than about a description of it.
 *
 * CODEX_HOME is repointed at an empty directory throughout. Without that, the
 * ChatGPT chain's third fallback reads whatever `~/.codex/auth.json` the
 * developer's machine happens to hold and the suite passes or fails according
 * to whether they use the Codex CLI.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { resetProviderConfiguration } from 'src/commands/logout/resetProviderConfig.js'
import {
  chatgptAuthFilePath,
  getStoredChatGPTAccountId,
  getValidChatGPTAuth,
  getValidChatGPTAuthForSearch,
  hasStoredChatGPTAuth,
  hasStoredChatGPTAuthSync,
  removeChatGPTAuth,
} from 'src/services/api/openai/chatgptAuth.js'
import { hasGeminiOAuthCredentialsSync } from 'src/services/api/gemini/oauthToken.js'
import {
  _resetAntigravityRefreshStateForTesting,
  getValidAntigravityAuth,
  getValidAntigravitySearchAuth,
} from 'src/services/auth/antigravity/oauth.js'
import {
  antigravityAuthFilePath,
  removeAntigravityTokens,
} from 'src/services/auth/antigravity/store.js'
import type { SettingsJson } from 'src/utils/settings/types.js'
import {
  autoPinSearchCredentials,
  copySearchOAuthLogin,
  hasSearchOAuthLogin,
  removeSearchOAuthLogin,
  setSearchAutoPinEnabled,
} from '../autoPin.js'
import {
  hasSearchOAuthCopy,
  listSearchOAuthCopies,
  searchOAuthCopyPath,
  syncSearchOAuthCopy,
} from '../oauthCopies.js'
import {
  hasCodexSearchCredentials,
  hasGeminiSearchCredentials,
} from '../sourceCredentials.js'
import { reloadPinnedSearchCredentials } from '../searchCredentialStore.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const settingsMock = setupSettingsMock()

let persistedSettings: SettingsJson = {}

const ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GEMINI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_AUTH_MODE',
  'CODEX_HOME',
] as const

const savedEnv = new Map<string, string | undefined>()
const savedConfigDir = process.env.OCC_CONFIG_DIR
const savedFetch = globalThis.fetch
let tempDir: string

/** A JWT-shaped token whose payload decodes, so the expiry probe has an answer. */
function jwt(payload: Record<string, unknown>): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `header.${body}.signature`
}

function writeChatGPTFile(
  path: string,
  tokens: { access: string; refresh: string; account?: string },
  extra: Record<string, unknown> = {},
): void {
  mkdirSync(occConfigDir(), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        auth_mode: 'chatgpt',
        tokens: {
          id_token: jwt({
            'https://api.openai.com/auth': {
              chatgpt_account_id: tokens.account ?? 'acct-main',
            },
          }),
          access_token: tokens.access,
          refresh_token: tokens.refresh,
        },
        ...extra,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

function writeAntigravityFile(
  path: string,
  tokens: { access: string; refresh: string; expiresAt: number },
): void {
  mkdirSync(occConfigDir(), { recursive: true })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        auth_mode: 'antigravity',
        tokens: {
          access_token: tokens.access,
          refresh_token: tokens.refresh,
          expires_at: tokens.expiresAt,
          email: 'someone@example.com',
          project_id: 'proj-1',
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
}

function readJSON(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function chatgptAccessToken(path: string): unknown {
  return (readJSON(path).tokens as Record<string, unknown> | undefined)
    ?.access_token
}

beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key])
  settingsMock.set({
    getSettingsForSource: source =>
      source === 'userSettings' ? persistedSettings : null,
    getSettings_DEPRECATED: () => persistedSettings,
    updateSettingsForSource: (_source, settings) => {
      const patch = settings as unknown as {
        env?: Record<string, string | undefined>
      } & Record<string, unknown>
      const env = { ...(persistedSettings.env ?? {}) }
      for (const [key, value] of Object.entries(patch.env ?? {})) {
        if (value === undefined) delete env[key]
        else env[key] = value
      }
      persistedSettings = { ...persistedSettings, ...patch, env }
      return { error: null }
    },
  })
})

afterAll(() => {
  settingsMock.reset()
  globalThis.fetch = savedFetch
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
})

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-search-oauth-'))
  process.env.OCC_CONFIG_DIR = tempDir
  occConfigDir.cache.clear?.()
  reloadPinnedSearchCredentials()
  persistedSettings = {}
  for (const key of ENV_KEYS) delete process.env[key]
  // An empty Codex home: the ChatGPT chain's last fallback must not reach the
  // developer's own ~/.codex/auth.json.
  process.env.CODEX_HOME = join(tempDir, 'codex-home')
  mkdirSync(process.env.CODEX_HOME, { recursive: true })
  _resetAntigravityRefreshStateForTesting()
})

afterEach(() => {
  globalThis.fetch = savedFetch
  for (const key of ENV_KEYS) delete process.env[key]
  rmSync(tempDir, { recursive: true, force: true })
  reloadPinnedSearchCredentials()
  _resetAntigravityRefreshStateForTesting()
})

describe('pinning a login copies its file', () => {
  test('S on a ChatGPT row writes a copy at 0600', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })

    expect(hasSearchOAuthLogin('codex')).toBe(true)
    expect(await copySearchOAuthLogin('codex')).toBe('copied')

    const copy = searchOAuthCopyPath('codex')
    expect(readFileSync(copy, 'utf8')).toBe(
      readFileSync(chatgptAuthFilePath(), 'utf8'),
    )
    // The copy holds a refresh token; anything looser than 0600 would be a
    // downgrade of the file it was copied from.
    expect(statSync(copy).mode & 0o777).toBe(0o600)
    expect(listSearchOAuthCopies()).toEqual(['codex'])
  })

  test('S on a Google row copies the Antigravity login', async () => {
    writeAntigravityFile(antigravityAuthFilePath(), {
      access: 'goog-1',
      refresh: 'goog-refresh',
      expiresAt: Date.now() + 3_600_000,
    })

    expect(await copySearchOAuthLogin('gemini')).toBe('copied')
    expect(hasSearchOAuthCopy('gemini')).toBe(true)
    expect(listSearchOAuthCopies()).toEqual(['gemini'])
  })

  test('nothing to copy is not an error', async () => {
    expect(hasSearchOAuthLogin('codex')).toBe(false)
    expect(await copySearchOAuthLogin('codex')).toBe('absent')
    expect(hasSearchOAuthCopy('codex')).toBe(false)
  })

  test('a source with no occ-owned login file has nothing to copy', async () => {
    // `anthropic`'s subscription login is a keychain record, not a file — see
    // SEARCH_OAUTH_FAMILIES.
    expect(hasSearchOAuthLogin('anthropic')).toBe(false)
    expect(await copySearchOAuthLogin('anthropic')).toBe('absent')
  })
})

describe('the copy outlives /logout', () => {
  test('removeChatGPTAuth + resetProviderConfiguration leave it, and the search chain reads it', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
      account: 'acct-42',
    })
    await copySearchOAuthLogin('codex')
    persistedSettings = { env: { OPENAI_API_KEY: 'sk-provider' } }
    process.env.OPENAI_API_KEY = 'sk-provider'

    await removeChatGPTAuth()
    resetProviderConfiguration()

    // The account plane really was reset — without this the assertions below
    // would hold against a build that never removed anything.
    expect(existsSync(chatgptAuthFilePath())).toBe(false)
    expect(process.env.OPENAI_API_KEY).toBeUndefined()

    expect(hasSearchOAuthCopy('codex')).toBe(true)
    // The search lane's own entry finds it, and reports the account the request
    // will be made as.
    const auth = await getValidChatGPTAuthForSearch()
    expect(auth.accessToken).toBe('access-1')
    expect(auth.accountId).toBe('acct-42')
    expect(await getStoredChatGPTAccountId()).toBe('acct-42')
  })

  test('the codex source stays connected after the login file is gone', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await copySearchOAuthLogin('codex')

    await removeChatGPTAuth()

    // Before the copy, this is exactly where the row went dark and the tool
    // silently dropped to the keyless scraping lane.
    expect(hasStoredChatGPTAuthSync()).toBe(true)
    expect(await hasStoredChatGPTAuth()).toBe(true)
    expect(hasCodexSearchCredentials()).toBe(true)
  })

  test('removeAntigravityTokens + resetProviderConfiguration leave the Google copy', async () => {
    writeAntigravityFile(antigravityAuthFilePath(), {
      access: 'goog-1',
      refresh: 'goog-refresh',
      expiresAt: Date.now() + 3_600_000,
    })
    await copySearchOAuthLogin('gemini')
    persistedSettings = { env: { GEMINI_API_KEY: 'AIza-provider' } }
    process.env.GEMINI_API_KEY = 'AIza-provider'

    await removeAntigravityTokens()
    resetProviderConfiguration()

    expect(existsSync(antigravityAuthFilePath())).toBe(false)
    expect(process.env.GEMINI_API_KEY).toBeUndefined()

    expect(hasSearchOAuthCopy('gemini')).toBe(true)
    expect(hasGeminiOAuthCredentialsSync()).toBe(true)
    expect(hasGeminiSearchCredentials()).toBe(true)
    const auth = await getValidAntigravitySearchAuth()
    expect(auth.accessToken).toBe('goog-1')
    expect(auth.projectId).toBe('proj-1')
  })
})

describe('the provider plane cannot see the copy', () => {
  test('getValidChatGPTAuth refuses once the login file is gone', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await copySearchOAuthLogin('codex')
    await removeChatGPTAuth()

    // If this resolved, `/logout` would not log the main loop out — the copy
    // would simply be a second place the account plane authenticates from.
    await expect(getValidChatGPTAuth()).rejects.toThrow(/not logged in/i)
    // And the search plane, on the same disk, still works.
    expect((await getValidChatGPTAuthForSearch()).accessToken).toBe('access-1')
  })

  test('getValidAntigravityAuth refuses once the login file is gone', async () => {
    writeAntigravityFile(antigravityAuthFilePath(), {
      access: 'goog-1',
      refresh: 'goog-refresh',
      expiresAt: Date.now() + 3_600_000,
    })
    await copySearchOAuthLogin('gemini')
    await removeAntigravityTokens()

    await expect(getValidAntigravityAuth()).rejects.toThrow(/not logged in/i)
    expect((await getValidAntigravitySearchAuth()).accessToken).toBe('goog-1')
  })

  test('the login file outranks the copy while both exist', async () => {
    // The provider plane refreshes the login file on every request, so it is
    // the fresher of the two by construction. A copy that outranked it would
    // serve a token that had been rotated away.
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'live-token',
      refresh: 'refresh-live',
      account: 'acct-live',
    })
    writeChatGPTFile(
      searchOAuthCopyPath('codex'),
      { access: 'stale-token', refresh: 'refresh-stale', account: 'acct-old' },
      { last_refresh: new Date().toISOString() },
    )

    expect((await getValidChatGPTAuthForSearch()).accessToken).toBe(
      'live-token',
    )
    expect(await getStoredChatGPTAccountId()).toBe('acct-live')
  })
})

describe('a refresh of the copy stays in the copy', () => {
  test('ChatGPT: the login file is not recreated', async () => {
    // No `last_refresh` ⇒ stale ⇒ the chain refreshes. That is the only path
    // that writes, and the whole question is which file it writes to: writing
    // the login file would resurrect, from inside a web search, the account the
    // user had just logged out of.
    writeChatGPTFile(searchOAuthCopyPath('codex'), {
      access: 'old-access',
      refresh: 'old-refresh',
    })
    expect(existsSync(chatgptAuthFilePath())).toBe(false)

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id_token: jwt({
            'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' },
          }),
          access_token: 'new-access',
          refresh_token: 'new-refresh',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

    expect((await getValidChatGPTAuthForSearch()).accessToken).toBe(
      'new-access',
    )

    expect(chatgptAccessToken(searchOAuthCopyPath('codex'))).toBe('new-access')
    expect(existsSync(chatgptAuthFilePath())).toBe(false)
  })

  test('Antigravity: the login file is not recreated', async () => {
    writeAntigravityFile(searchOAuthCopyPath('gemini'), {
      access: 'expired',
      refresh: 'goog-refresh',
      expiresAt: Date.now() - 1000,
    })
    expect(existsSync(antigravityAuthFilePath())).toBe(false)

    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          access_token: 'fresh-google',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as unknown as typeof fetch

    expect((await getValidAntigravitySearchAuth(fetchImpl)).accessToken).toBe(
      'fresh-google',
    )

    const copy = readJSON(searchOAuthCopyPath('gemini'))
    expect((copy.tokens as Record<string, unknown>).access_token).toBe(
      'fresh-google',
    )
    expect(existsSync(antigravityAuthFilePath())).toBe(false)
  })
})

describe('D removes the copy', () => {
  test('and says so, once', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await copySearchOAuthLogin('codex')

    expect(await removeSearchOAuthLogin('codex')).toBe(true)
    expect(hasSearchOAuthCopy('codex')).toBe(false)
    // Idempotent: a second D on a row that no longer has a copy answers false
    // and falls through to the panel's disconnect branch.
    expect(await removeSearchOAuthLogin('codex')).toBe(false)
    // The login itself is untouched — two credentials, two undos.
    expect(existsSync(chatgptAuthFilePath())).toBe(true)
  })

  test('a source with no copyable login answers false rather than throwing', async () => {
    expect(await removeSearchOAuthLogin('deepseek')).toBe(false)
  })
})

describe('the automatic pass', () => {
  test('copies both logins and reports what it did', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    writeAntigravityFile(antigravityAuthFilePath(), {
      access: 'goog-1',
      refresh: 'goog-refresh',
      expiresAt: Date.now() + 3_600_000,
    })

    const results = await autoPinSearchCredentials()

    const oauthFor = (family: string) =>
      results.find(result => result.family === family)?.oauth
    expect(oauthFor('codex')).toBe('oauth-copied')
    expect(oauthFor('gemini')).toBe('oauth-copied')
    // Every family answers, including the two that have no login file — the
    // result is how a caller asks "what happened to anthropic", and an absent
    // field is a state the union does not describe.
    expect(oauthFor('anthropic')).toBe('oauth-unsupported')
    expect(oauthFor('deepseek')).toBe('oauth-unsupported')
    expect(listSearchOAuthCopies().sort()).toEqual(['codex', 'gemini'])
  })

  test('writes nothing when the copy already matches', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await autoPinSearchCredentials()
    const copy = searchOAuthCopyPath('codex')
    const before = statSync(copy).mtimeMs
    const contents = readFileSync(copy, 'utf8')

    const results = await autoPinSearchCredentials()

    // This runs on every startup. A file that is rewritten each time is a file
    // whose mtime says nothing about when the login was pinned.
    expect(results.find(result => result.family === 'codex')?.oauth).toBe(
      'oauth-unchanged',
    )
    expect(statSync(copy).mtimeMs).toBe(before)
    expect(readFileSync(copy, 'utf8')).toBe(contents)
  })

  test('follows the login file when it changes', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await autoPinSearchCredentials()

    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-2',
      refresh: 'refresh-2',
    })
    const results = await autoPinSearchCredentials()

    expect(results.find(result => result.family === 'codex')?.oauth).toBe(
      'oauth-synced',
    )
    expect(chatgptAccessToken(searchOAuthCopyPath('codex'))).toBe('access-2')
  })

  test('a copy outlives a login file that has gone away', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    await autoPinSearchCredentials()

    await removeChatGPTAuth()
    const results = await autoPinSearchCredentials()

    // "The login went away" is the /logout case this feature exists for, and
    // it must never be read as a reason to drop what was captured earlier.
    expect(results.find(result => result.family === 'codex')?.oauth).toBe(
      'oauth-absent',
    )
    expect(hasSearchOAuthCopy('codex')).toBe(true)
  })

  test('the opt-out D writes covers the login as well as the key', async () => {
    writeChatGPTFile(chatgptAuthFilePath(), {
      access: 'access-1',
      refresh: 'refresh-1',
    })
    setSearchAutoPinEnabled('codex', false)

    const results = await autoPinSearchCredentials()

    expect(results.find(result => result.family === 'codex')?.oauth).toBe(
      'oauth-opted-out',
    )
    expect(hasSearchOAuthCopy('codex')).toBe(false)
  })
})

describe('the copy path is isolated like every other credential file', () => {
  test('it follows OCC_CONFIG_DIR and never ~/.claude', () => {
    expect(searchOAuthCopyPath('codex')).toBe(
      occConfigPath('search-oauth-chatgpt.json'),
    )
    expect(searchOAuthCopyPath('gemini')).toBe(
      occConfigPath('search-oauth-antigravity.json'),
    )
    expect(searchOAuthCopyPath('codex').startsWith(tempDir)).toBe(true)
  })

  test('an unreadable source leaves an existing copy alone', async () => {
    writeChatGPTFile(searchOAuthCopyPath('codex'), {
      access: 'kept',
      refresh: 'kept-refresh',
    })

    expect(
      await syncSearchOAuthCopy('codex', join(tempDir, 'no-such-file.json')),
    ).toBe('absent')
    expect(chatgptAccessToken(searchOAuthCopyPath('codex'))).toBe('kept')
  })
})
