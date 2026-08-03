import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { AccountInfo, GlobalConfig } from '../../../utils/config/config.js'
import * as realConfig from '../../../utils/config/config.js'
import { authMockWith } from '../../../../tests/mocks/auth.js'
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
}

type StoredMetricsCache = {
  enabled: boolean
  timestamp: number
  identityKey?: string
}

let account: AccountInfo
let storedCache: StoredMetricsCache | undefined

mock.module(
  'src/utils/auth/auth.js',
  authMockWith({
    isClaudeAISubscriber: () => true,
    hasProfileScope: () => true,
    getOauthAccountInfo: () => account,
    getAnthropicApiKeyWithSource: () => ({ key: null, source: 'none' }),
  }),
)
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const configMock = makeSharedModuleMock(
  'src/utils/config/config.js',
  realConfig,
).setup({
  getGlobalConfig: () =>
    ({ metricsStatusCache: storedCache }) as unknown as GlobalConfig,
  saveGlobalConfig: updater => {
    const current = {
      metricsStatusCache: storedCache,
    } as unknown as GlobalConfig
    const next = updater(current)
    storedCache = next.metricsStatusCache as StoredMetricsCache | undefined
  },
})

const axiosMock = setupAxiosMock()

afterAll(() => {
  axiosMock.useStubs = false
  configMock.reset()
  mock.module('src/utils/auth/auth.js', authMockWith())
})

import {
  _resetMetricsOptOutCacheForTesting,
  checkMetricsEnabled,
} from '../metricsOptOut.js'

function oauthAccount(
  organizationUuid: string,
  accountUuid: string,
): AccountInfo {
  return {
    organizationUuid,
    accountUuid,
    emailAddress: `${accountUuid}@example.com`,
  }
}

beforeEach(() => {
  account = oauthAccount('org-a', 'account-a')
  storedCache = undefined
  axiosMock.useStubs = true
  axiosMock.stubs = {}
  _resetMetricsOptOutCacheForTesting()
})

describe('metrics opt-out identity cache', () => {
  test('does not reuse an in-flight or disk result after an account switch', async () => {
    let resolveFirst: ((enabled: boolean) => void) | undefined
    let calls = 0
    axiosMock.stubs.get = async () => {
      calls++
      if (calls === 1) {
        const enabled = await new Promise<boolean>(resolve => {
          resolveFirst = resolve
        })
        return { data: { metrics_logging_enabled: enabled } }
      }
      return { data: { metrics_logging_enabled: false } }
    }

    const oldAccountCheck = checkMetricsEnabled()
    await Promise.resolve()
    account = oauthAccount('org-b', 'account-b')
    const newAccountCheck = checkMetricsEnabled()

    expect(await newAccountCheck).toEqual({ enabled: false, hasError: false })
    resolveFirst?.(true)
    expect(await oldAccountCheck).toEqual({ enabled: false, hasError: false })
    expect(calls).toBe(2)
    expect(storedCache?.enabled).toBe(false)
    expect(storedCache?.identityKey).toContain('org-b')
    expect(storedCache?.identityKey).toContain('account-b')
  })

  test('treats an unbound legacy disk entry as a cache miss', async () => {
    storedCache = { enabled: true, timestamp: Date.now() }
    let calls = 0
    axiosMock.stubs.get = async () => {
      calls++
      return { data: { metrics_logging_enabled: false } }
    }

    expect(await checkMetricsEnabled()).toEqual({
      enabled: false,
      hasError: false,
    })
    expect(calls).toBe(1)
    expect(storedCache?.identityKey).toContain('org-a')
  })
})
