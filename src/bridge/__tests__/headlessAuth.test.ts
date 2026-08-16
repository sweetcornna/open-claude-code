import { describe, expect, test } from 'bun:test'
import { BIN_NAME } from '../../constants/brand.js'
import {
  ensureHeadlessBridgeCredential,
  type HeadlessAuthPreparation,
} from '../headlessAuth.js'

/**
 * Everything is injected, so there is no auth module to mock — the fakes are
 * just the functions the gate calls.
 */
function deps(
  overrides: Partial<{
    selfHosted: boolean
    baseUrl: string
    prepare: (baseUrl: string) => Promise<HeadlessAuthPreparation>
    getAccessToken: () => string | undefined
  }> = {},
) {
  return {
    selfHosted: true,
    baseUrl: 'https://rc.example.test',
    prepare: async () => ({ status: 'authenticated' }) as const,
    getAccessToken: () => 'access-token',
    ...overrides,
  }
}

describe('ensureHeadlessBridgeCredential', () => {
  test('runs account preparation before looking for a token', async () => {
    const calls: string[] = []
    let token: string | undefined
    await ensureHeadlessBridgeCredential(
      deps({
        prepare: async (baseUrl: string) => {
          calls.push(`prepare:${baseUrl}`)
          // This is the whole point: preparation is what turns the stored
          // refresh credential into the access token the next line reads.
          token = 'minted-by-prepare'
          return { status: 'authenticated' }
        },
        getAccessToken: () => {
          calls.push('getAccessToken')
          return token
        },
      }),
    )
    expect(calls).toEqual(['prepare:https://rc.example.test', 'getAccessToken'])
  })

  // The regression this gate exists for: the daemon worker skipped
  // preparation, so a fresh process saw an empty in-memory token store and
  // reported the claude.ai login error for an account-server problem.
  test('names /remote-control login when the account needs one', async () => {
    const promise = ensureHeadlessBridgeCredential(
      deps({
        prepare: async () => ({ status: 'login_required' }),
        getAccessToken: () => undefined,
      }),
    )
    await expect(promise).rejects.toThrow(/auth_required/)
    await expect(promise).rejects.toThrow(
      new RegExp(`${BIN_NAME}\`? and use \`/remote-control login\``),
    )
  })

  test('login_required never reports the claude.ai /login advice', async () => {
    const error = await ensureHeadlessBridgeCredential(
      deps({ prepare: async () => ({ status: 'login_required' }) }),
    ).catch((e: Error) => e)
    expect(String(error)).not.toContain('claude.ai subscriptions')
  })

  test('an unreachable server is reported with its URL', async () => {
    await expect(
      ensureHeadlessBridgeCredential(
        deps({
          baseUrl: 'https://down.example.test',
          prepare: () => Promise.reject(new Error('ECONNREFUSED')),
        }),
      ),
    ).rejects.toThrow(
      'Unable to reach the Remote Control server at https://down.example.test: ECONNREFUSED',
    )
  })

  // A pre-0.2 self-hosted server answers "legacy" and has no account to log
  // into, so pointing at /remote-control login would be a dead end.
  test('a legacy server with no credential says so instead', async () => {
    await expect(
      ensureHeadlessBridgeCredential(
        deps({
          prepare: async () => ({ status: 'legacy' }),
          getAccessToken: () => undefined,
        }),
      ),
    ).rejects.toThrow(/pre-0\.2 build/)
  })

  test('a legacy server with an explicit credential passes', async () => {
    await ensureHeadlessBridgeCredential(
      deps({
        prepare: async () => ({ status: 'legacy' }),
        getAccessToken: () => 'legacy-api-key',
      }),
    )
  })

  test('claude.ai keeps the claude.ai error and skips preparation', async () => {
    let prepared = false
    await expect(
      ensureHeadlessBridgeCredential(
        deps({
          selfHosted: false,
          prepare: async () => {
            prepared = true
            return { status: 'authenticated' }
          },
          getAccessToken: () => undefined,
        }),
      ),
    ).rejects.toThrow(/logged in to use Remote Control/)
    expect(prepared).toBe(false)
  })

  // Transient on purpose: the supervisor retries with backoff and parks only
  // after repeated rapid failures, so a worker started before the user logs
  // in recovers on its own instead of needing a manual unpark.
  test('every failure is a plain Error, not a permanent one', async () => {
    const error = await ensureHeadlessBridgeCredential(
      deps({ prepare: async () => ({ status: 'login_required' }) }),
    ).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).name).toBe('Error')
  })
})
