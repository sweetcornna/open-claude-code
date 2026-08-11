/**
 * What a Console credential carries, and what survives an hourly refresh.
 *
 * No mocks: the store is `fs` plus `occConfigPath()`, so pointing
 * `OCC_CONFIG_DIR` at a temp directory exercises the real write and the real
 * read. `refreshTokens` is the one network call, and it is stubbed at
 * `globalThis.fetch` the way deviceFlow.test.ts does — mocking the module would
 * replace the very code path this file is about.
 *
 * The invariant under test is the one that made Console sign-in unusable: a
 * Console session's endpoint and headers come from `GET {console}/api/config`,
 * not from a constant, so they have to outlive the access token they were
 * fetched with. The refresh answers with tokens and nothing else — anything
 * stored beside the token rather than beside the ACCOUNT is gone an hour in.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OPENCODE_AUTH_FILE } from '../constants.js'
import {
  _resetOpencodeRefreshStateForTesting,
  getOpencodeCredential,
  opencodeAuthHeaders,
} from '../oauth.js'
import { readOpencodeTokens, saveOpencodeTokens } from '../store.js'

const CONSOLE = 'https://console.opencode.ai'
const INFERENCE = 'https://console.opencode.ai/inference/openai/v1'
const realFetch = globalThis.fetch
const savedConfigDir = process.env.OCC_CONFIG_DIR
const savedApiKey = process.env.OPENCODE_API_KEY
let configDir: string

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'occ-opencode-'))
  process.env.OCC_CONFIG_DIR = configDir
  delete process.env.OPENCODE_API_KEY
  _resetOpencodeRefreshStateForTesting()
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await rm(configDir, { recursive: true, force: true })
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = savedConfigDir
  if (savedApiKey === undefined) delete process.env.OPENCODE_API_KEY
  else process.env.OPENCODE_API_KEY = savedApiKey
})

const CONSOLE_TOKENS = {
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 3_600_000,
  server: CONSOLE,
  orgId: 'org-from-orgs-api',
  inference: {
    api: INFERENCE,
    headers: { 'x-org-id': 'org_01KZ' },
  },
}

describe('a stored Console credential', () => {
  test('hands the request path the endpoint and headers /api/config named', async () => {
    await saveOpencodeTokens(CONSOLE_TOKENS)
    const credential = await getOpencodeCredential()

    expect(credential?.token).toBe('access-1')
    // The endpoint is per-account and cannot be a constant: this token answers
    // 200 here and 401 at https://opencode.ai/zen/v1.
    expect(credential?.inferenceUrl).toBe(INFERENCE)
    expect(credential?.headers).toEqual({ 'x-org-id': 'org_01KZ' })
  })

  test('the console’s org wins over occ’s own pick from /api/orgs', async () => {
    // Two sources can name an organization. When the console states which one
    // the provider is scoped to, that is not a tie to break.
    await saveOpencodeTokens(CONSOLE_TOKENS)
    const credential = await getOpencodeCredential()
    expect(credential).not.toBeNull()

    expect(opencodeAuthHeaders(credential!)).toEqual({
      authorization: 'Bearer access-1',
      'x-org-id': 'org_01KZ',
    })
  })

  test('an API key names no endpoint — that session picked Zen or Go itself', async () => {
    await saveOpencodeTokens(CONSOLE_TOKENS)
    process.env.OPENCODE_API_KEY = 'zen-key'
    const credential = await getOpencodeCredential()

    expect(credential).toEqual({ token: 'zen-key', kind: 'key' })
    expect(opencodeAuthHeaders(credential!)).toEqual({
      authorization: 'Bearer zen-key',
    })
  })

  test('survives the hourly refresh, which answers with tokens alone', async () => {
    await saveOpencodeTokens({
      ...CONSOLE_TOKENS,
      // Inside the refresh margin, so the read below renews before returning.
      expiresAt: Date.now() - 1_000,
    })
    let refreshed = false
    globalThis.fetch = (async () => {
      refreshed = true
      return new Response(
        JSON.stringify({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as unknown as typeof fetch

    const credential = await getOpencodeCredential()
    expect(refreshed).toBe(true)
    // The new bearer has to reach the client…
    expect(credential?.token).toBe('access-2')
    // …and the plane the login read has to still be there, in memory and on
    // disk. Stored beside the token instead of beside the account, it would be
    // gone at the first renewal and every later request would go to whatever
    // constant occ fell back to.
    expect(credential?.inferenceUrl).toBe(INFERENCE)
    expect(credential?.headers).toEqual({ 'x-org-id': 'org_01KZ' })
    expect((await readOpencodeTokens())?.inference).toEqual({
      api: INFERENCE,
      headers: { 'x-org-id': 'org_01KZ' },
    })
  })

  test('a credential file with no plane is a Zen/Go session, not a broken one', async () => {
    const { inference: _dropped, ...zen } = CONSOLE_TOKENS
    await saveOpencodeTokens(zen)
    const credential = await getOpencodeCredential()

    expect(credential?.inferenceUrl).toBeUndefined()
    expect(credential?.headers).toBeUndefined()
    // The org id from /api/orgs is still the header source in that case.
    expect(opencodeAuthHeaders(credential!)['x-org-id']).toBe(
      'org-from-orgs-api',
    )
  })

  test('the token file lives in occ’s own config dir', async () => {
    // Isolation invariant: never ~/.claude, never the official CLI's keychain
    // record, never opencode's own auth.json.
    await saveOpencodeTokens(CONSOLE_TOKENS)
    expect(await Bun.file(join(configDir, OPENCODE_AUTH_FILE)).exists()).toBe(
      true,
    )
  })
})
