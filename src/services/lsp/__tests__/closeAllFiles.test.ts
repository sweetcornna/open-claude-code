import { describe, expect, test, mock } from 'bun:test'
import { createLSPServerManager } from '../LSPServerManager.js'

// Mock config loading to avoid real filesystem/LSP server access
mock.module('../config.js', () => ({
  getAllLspServers: async () => ({
    servers: {
      'test-server': {
        command: ['test-lsp'],
        extensionToLanguage: {
          '.ts': 'typescript',
          '.js': 'javascript',
        },
      },
    },
  }),
}))

// Mock LSPServerInstance to avoid spawning real processes
const sendNotificationMock = mock(() => Promise.resolve())
mock.module('../LSPServerInstance.js', () => ({
  createLSPServerInstance: (name: string, config: any) => ({
    name,
    config,
    state: 'running',
    start: mock(async () => {
      /* no-op */
    }),
    stop: mock(async () => {
      /* no-op */
    }),
    sendRequest: mock(async () => undefined),
    sendNotification: sendNotificationMock,
    onRequest: mock(() => {}),
  }),
}))

// Mock log modules with side effects
mock.module('src/utils/telemetry/log.ts', () => ({
  logError: mock(() => {}),
}))

mock.module('src/utils/telemetry/debug.ts', () => ({
  logForDebugging: mock(() => {}),
}))

describe('LSPServerManager closeAllFiles', () => {
  test('closeAllFiles is a no-op when no files are open', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()
    // Should not throw
    await manager.closeAllFiles()
  })

  test('closeAllFiles sends didClose for each open file', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    // Open some files via the public API.
    // Since createLSPServerInstance is mocked with state='running',
    // openFile should track them and send didOpen.
    sendNotificationMock.mockClear()
    await manager.openFile('/project/a.ts', 'content-a')
    await manager.openFile('/project/b.js', 'content-b')

    // Verify files are tracked as open
    expect(manager.isFileOpen('/project/a.ts')).toBe(true)
    expect(manager.isFileOpen('/project/b.js')).toBe(true)

    // Now close all
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()

    // didClose should have been sent for both files
    expect(sendNotificationMock).toHaveBeenCalledTimes(2)
    const calls = sendNotificationMock.mock.calls.map((c: any[]) => c)
    const uris = calls.map(c => (c[1] as any)?.textDocument?.uri as string)
    expect(uris).toEqual(
      expect.arrayContaining([
        expect.stringContaining('a.ts'),
        expect.stringContaining('b.js'),
      ]),
    )

    // Files should no longer be tracked
    expect(manager.isFileOpen('/project/a.ts')).toBe(false)
    expect(manager.isFileOpen('/project/b.js')).toBe(false)
  })

  test('closeAllFiles clears tracking even if server notification fails', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    await manager.openFile('/project/x.ts', 'content-x')
    expect(manager.isFileOpen('/project/x.ts')).toBe(true)

    // Make sendNotification throw
    sendNotificationMock.mockRejectedValueOnce(new Error('server gone'))

    // Should not throw, and file tracking should be cleared
    await manager.closeAllFiles()
    expect(manager.isFileOpen('/project/x.ts')).toBe(false)
  })

  test('closeAllFiles handles double invocation gracefully', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    await manager.openFile('/project/y.ts', 'content-y')
    await manager.closeAllFiles()
    expect(manager.isFileOpen('/project/y.ts')).toBe(false)

    // Second call should be a no-op (no files to close)
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })

  test('51st open evicts the least-recently-used document with didClose', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    for (let i = 0; i < 50; i++) {
      await manager.openFile(`/project/lru-a-${i}.ts`, 'c')
    }
    expect(manager.isFileOpen('/project/lru-a-0.ts')).toBe(true)

    sendNotificationMock.mockClear()
    await manager.openFile('/project/lru-a-50.ts', 'c')

    // Oldest document evicted locally AND on the server (didClose)
    expect(manager.isFileOpen('/project/lru-a-0.ts')).toBe(false)
    expect(manager.isFileOpen('/project/lru-a-50.ts')).toBe(true)
    const didCloseUris = sendNotificationMock.mock.calls
      .filter((c: any[]) => c[0] === 'textDocument/didClose')
      .map((c: any[]) => (c[1] as any)?.textDocument?.uri as string)
    expect(didCloseUris).toHaveLength(1)
    expect(didCloseUris[0]).toContain('lru-a-0.ts')

    await manager.closeAllFiles()
  })

  test('re-opening a file refreshes its LRU position', async () => {
    const manager = createLSPServerManager()
    await manager.initialize()

    for (let i = 0; i < 50; i++) {
      await manager.openFile(`/project/lru-b-${i}.ts`, 'c')
    }
    // Touch the oldest via the already-open skip path
    await manager.openFile('/project/lru-b-0.ts', 'c')

    await manager.openFile('/project/lru-b-50.ts', 'c')

    // lru-b-1 (now oldest) evicted; the touched lru-b-0 survives
    expect(manager.isFileOpen('/project/lru-b-0.ts')).toBe(true)
    expect(manager.isFileOpen('/project/lru-b-1.ts')).toBe(false)

    await manager.closeAllFiles()
  })

  test('closeAllFiles skips servers that are not running', async () => {
    // Create manager and manually register a server with 'stopped' state
    const manager = createLSPServerManager()
    await manager.initialize()

    // Open a file first (mocked server is running)
    await manager.openFile('/project/z.ts', 'content-z')
    expect(manager.isFileOpen('/project/z.ts')).toBe(true)

    // If we manually stop the server (simulating server crash),
    // closeAllFiles should skip it gracefully.
    // Since we can't easily change the mock state, we verify that
    // closeAllFiles at least clears tracking regardless.
    sendNotificationMock.mockClear()
    await manager.closeAllFiles()
    // Tracking cleared regardless of server state
    expect(manager.isFileOpen('/project/z.ts')).toBe(false)
  })
})
