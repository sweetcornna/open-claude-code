import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import { setupLspConfigMock } from '../../../../tests/mocks/lspConfig.js'
import { setupLspServerInstanceMock } from '../../../../tests/mocks/lspServerInstance.js'
import type { LSPServerInstance } from '../LSPServerInstance.js'
import type { LspServerState, ScopedLspServerConfig } from '../types.js'

let serverConfigs: Record<string, ScopedLspServerConfig> = {}
const startBehaviors = new Map<string, () => Promise<void>>()
const fakeServers = new Map<
  string,
  {
    instance: LSPServerInstance
    start: ReturnType<typeof mock>
    stop: ReturnType<typeof mock>
    setState: (state: LspServerState) => void
  }
>()
function createFakeServer(
  name: string,
  config: ScopedLspServerConfig,
): LSPServerInstance {
  let state: LspServerState = 'stopped'
  const start = mock(async () => {
    state = 'starting'
    try {
      await (startBehaviors.get(name)?.() ?? Promise.resolve())
      state = 'running'
    } catch (error) {
      state = 'error'
      throw error
    }
  })
  const stop = mock(async () => {
    state = 'stopped'
  })
  const instance = {
    name,
    config,
    get state() {
      return state
    },
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    start,
    stop,
    restart: mock(async () => {}),
    isHealthy: () => state === 'running',
    sendRequest: async <T>(): Promise<T> => undefined as unknown as T,
    sendNotification: mock(async () => {}),
    onNotification: mock(() => {}),
    onRequest: mock(() => {}),
  } as unknown as LSPServerInstance

  fakeServers.set(name, {
    instance,
    start,
    stop,
    setState: nextState => {
      state = nextState
    },
  })
  return instance
}

function createConfig(extension: string): ScopedLspServerConfig {
  return {
    command: 'test-lsp',
    transport: 'stdio',
    extensionToLanguage: { [extension]: 'test-language' },
    scope: 'dynamic',
    source: 'test-plugin',
  }
}

function createDeferred(): {
  promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
} {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = () => resolvePromise()
    reject = reason => rejectPromise(reason)
  })
  return { promise, resolve, reject }
}

const lspConfigMock = setupLspConfigMock({
  getAllLspServers: async () => ({ servers: serverConfigs }),
})
const lspServerInstanceMock = setupLspServerInstanceMock({
  createLSPServerInstance: (name, config) => createFakeServer(name, config),
})

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { createLSPServerManager } = await import('../LSPServerManager.js')

beforeEach(() => {
  serverConfigs = {}
  startBehaviors.clear()
  fakeServers.clear()
})

afterAll(() => {
  lspServerInstanceMock.reset()
  lspConfigMock.reset()
})

describe('LSPServerManager startup concurrency', () => {
  test('concurrent callers share one start for the same server', async () => {
    serverConfigs = { typescript: createConfig('.ts') }
    const startGate = createDeferred()
    startBehaviors.set('typescript', () => startGate.promise)
    const manager = createLSPServerManager()
    await manager.initialize()

    const first = manager.ensureServerStarted('/project/a.ts')
    const second = manager.ensureServerStarted('/project/b.ts')
    let secondSettled = false
    void second.then(() => {
      secondSettled = true
    })

    await Promise.resolve()
    await Promise.resolve()
    expect(fakeServers.get('typescript')?.start).toHaveBeenCalledTimes(1)
    expect(secondSettled).toBe(false)

    startGate.resolve()
    await Promise.all([first, second])
    expect(secondSettled).toBe(true)
  })

  test('concurrent callers share a failure and a later call retries', async () => {
    serverConfigs = { typescript: createConfig('.ts') }
    const startGate = createDeferred()
    startBehaviors.set('typescript', () => startGate.promise)
    const manager = createLSPServerManager()
    await manager.initialize()

    const first = manager.ensureServerStarted('/project/a.ts')
    const second = manager.ensureServerStarted('/project/b.ts')
    const resultsPromise = Promise.allSettled([first, second])
    const failure = new Error('startup failed')
    startGate.reject(failure)
    const results = await resultsPromise

    expect(fakeServers.get('typescript')?.start).toHaveBeenCalledTimes(1)
    expect(results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ])

    startBehaviors.set('typescript', async () => {})
    await manager.ensureServerStarted('/project/c.ts')
    expect(fakeServers.get('typescript')?.start).toHaveBeenCalledTimes(2)
  })

  test('different server instances start in parallel', async () => {
    serverConfigs = {
      typescript: createConfig('.ts'),
      javascript: createConfig('.js'),
    }
    const typescriptGate = createDeferred()
    const javascriptGate = createDeferred()
    startBehaviors.set('typescript', () => typescriptGate.promise)
    startBehaviors.set('javascript', () => javascriptGate.promise)
    const manager = createLSPServerManager()
    await manager.initialize()

    const typescriptStart = manager.ensureServerStarted('/project/a.ts')
    const javascriptStart = manager.ensureServerStarted('/project/a.js')

    expect(fakeServers.get('typescript')?.start).toHaveBeenCalledTimes(1)
    expect(fakeServers.get('javascript')?.start).toHaveBeenCalledTimes(1)

    typescriptGate.resolve()
    javascriptGate.resolve()
    await Promise.all([typescriptStart, javascriptStart])
  })

  test('shutdown stops a server again after an in-flight start settles', async () => {
    serverConfigs = { typescript: createConfig('.ts') }
    const startGate = createDeferred()
    startBehaviors.set('typescript', () => startGate.promise)
    const manager = createLSPServerManager()
    await manager.initialize()

    const start = manager.ensureServerStarted('/project/a.ts')
    const shutdown = manager.shutdown()
    let shutdownSettled = false
    void shutdown.finally(() => {
      shutdownSettled = true
    })

    await Promise.resolve()
    expect(fakeServers.get('typescript')?.stop).toHaveBeenCalledTimes(1)
    expect(shutdownSettled).toBe(false)

    startGate.resolve()
    await Promise.all([start, shutdown])

    expect(fakeServers.get('typescript')?.stop).toHaveBeenCalledTimes(2)
    expect(fakeServers.get('typescript')?.instance.state).toBe('stopped')
    expect(manager.getAllServers().size).toBe(0)
  })

  test('does not start a server after shutdown begins', async () => {
    serverConfigs = { typescript: createConfig('.ts') }
    const manager = createLSPServerManager()
    await manager.initialize()

    const shutdown = manager.shutdown()
    const start = manager.ensureServerStarted('/project/a.ts')
    await Promise.all([start, shutdown])

    expect(await start).toBeUndefined()
    expect(fakeServers.get('typescript')?.start).not.toHaveBeenCalled()
    expect(fakeServers.get('typescript')?.instance.state).toBe('stopped')
    expect(manager.getAllServers().size).toBe(0)
  })
})
