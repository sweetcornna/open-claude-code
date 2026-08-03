import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdtemp, readFile, readdir, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'
import type { ConnectedMCPServer } from '../types.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: unknown }).MACRO = {
    VERSION: '0.0.0-test',
    BUILD_TIME: '0',
  }
}

const {
  callMCPToolWithUrlElicitationRetry,
  clearMcpAuthCache,
  mcpAuthCacheForTesting,
} = await import('../client.js')
const { sanitizeMcpHeadersForLogging, sanitizeMcpUrlForLogging } = await import(
  '../auth.js'
)

describe('MCP logging sanitization', () => {
  test('removes URL credentials and redacts every header value', () => {
    expect(
      sanitizeMcpUrlForLogging(
        'https://user:password@example.com/mcp?access_token=url-secret#fragment-secret',
      ),
    ).toBe('https://example.com/mcp')

    expect(
      sanitizeMcpHeadersForLogging({
        Authorization: 'Bearer auth-secret',
        Cookie: 'session=cookie-secret',
        'X-API-Key': 'api-secret',
        'X-Custom-Header': 'custom-secret',
      }),
    ).toEqual({
      Authorization: '[REDACTED]',
      Cookie: '[REDACTED]',
      'X-API-Key': '[REDACTED]',
      'X-Custom-Header': '[REDACTED]',
    })
  })
})

describe('MCP needs-auth cache serialization', () => {
  const savedConfigDir = process.env.OCC_CONFIG_DIR
  let configDir = ''

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'occ-mcp-auth-cache-'))
    process.env.OCC_CONFIG_DIR = configDir
    clearMcpAuthCache()
    await mcpAuthCacheForTesting.waitForMutations()
  })

  afterEach(async () => {
    clearMcpAuthCache()
    await mcpAuthCacheForTesting.waitForMutations()
    await rm(configDir, { recursive: true, force: true })
  })

  afterAll(() => {
    if (savedConfigDir === undefined) {
      delete process.env.OCC_CONFIG_DIR
    } else {
      process.env.OCC_CONFIG_DIR = savedConfigDir
    }
  })

  test('a clear invalidates an older queued write instead of recreating the cache', async () => {
    mcpAuthCacheForTesting.set('server-before-login')
    clearMcpAuthCache()

    await mcpAuthCacheForTesting.waitForMutations()

    expect(await mcpAuthCacheForTesting.has('server-before-login')).toBe(false)
    await expect(
      readFile(join(configDir, 'mcp-needs-auth-cache.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('writes a complete cache through atomic replacement without leftover temp files', async () => {
    mcpAuthCacheForTesting.set('server-a')
    mcpAuthCacheForTesting.set('server-b')

    await mcpAuthCacheForTesting.waitForMutations()

    const cache = JSON.parse(
      await readFile(join(configDir, 'mcp-needs-auth-cache.json'), 'utf8'),
    ) as Record<string, unknown>
    expect(Object.keys(cache).sort()).toEqual(['server-a', 'server-b'])
    expect((await readdir(configDir)).some(name => name.endsWith('.tmp'))).toBe(
      false,
    )
  })
})

describe('MCP tool timeout cancellation', () => {
  test('aborts the underlying SDK call when the outer timeout wins', async () => {
    let callSignal: AbortSignal | undefined
    const sdkClient = {
      getProtocolEra: () => 'legacy' as const,
      callTool: (
        _params: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<never> => {
        callSignal = options?.signal
        return new Promise((_, reject) => {
          const rejectOnAbort = (): void => {
            reject(new DOMException('underlying call aborted', 'AbortError'))
          }
          if (callSignal?.aborted) {
            rejectOnAbort()
          } else {
            callSignal?.addEventListener('abort', rejectOnAbort, { once: true })
          }
        })
      },
    }
    const connection = {
      type: 'connected',
      name: 'timeout-fixture',
      capabilities: {},
      client: sdkClient,
      config: {
        type: 'stdio',
        command: 'noop',
        scope: 'user',
        request_timeout_ms: 10,
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer

    await expect(
      callMCPToolWithUrlElicitationRetry({
        client: connection,
        clientConnection: connection,
        tool: 'slow-tool',
        args: {},
        signal: new AbortController().signal,
        setAppState: () => {},
      }),
    ).rejects.toThrow('timed out')

    expect(callSignal?.aborted).toBe(true)
  })

  test('preserves caller cancellation through the per-call controller', async () => {
    let callSignal: AbortSignal | undefined
    const sdkClient = {
      getProtocolEra: () => 'legacy' as const,
      callTool: (
        _params: unknown,
        options?: { signal?: AbortSignal },
      ): Promise<never> => {
        callSignal = options?.signal
        return new Promise((_, reject) => {
          const rejectOnAbort = (): void => {
            reject(new DOMException('underlying call aborted', 'AbortError'))
          }
          if (callSignal?.aborted) {
            rejectOnAbort()
          } else {
            callSignal?.addEventListener('abort', rejectOnAbort, { once: true })
          }
        })
      },
    }
    const connection = {
      type: 'connected',
      name: 'caller-cancel-fixture',
      capabilities: {},
      client: sdkClient,
      config: {
        type: 'stdio',
        command: 'noop',
        scope: 'user',
        request_timeout_ms: 60_000,
      },
      cleanup: async () => {},
    } as unknown as ConnectedMCPServer
    const caller = new AbortController()

    const resultPromise = callMCPToolWithUrlElicitationRetry({
      client: connection,
      clientConnection: connection,
      tool: 'cancelled-tool',
      args: {},
      signal: caller.signal,
      setAppState: () => {},
    })
    caller.abort('caller cancelled')

    await expect(resultPromise).resolves.toEqual({ content: undefined })
    expect(callSignal?.aborted).toBe(true)
    expect(callSignal?.reason).toBe('caller cancelled')
  })
})
