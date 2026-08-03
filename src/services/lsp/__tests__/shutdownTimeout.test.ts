import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, mock, test } from 'bun:test'
import type { ChildProcess } from 'node:child_process'
import type { InitializeParams } from 'vscode-languageserver-protocol'
import type { MessageConnection } from 'vscode-jsonrpc/node.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'
import type { LSPServerInstance } from '../LSPServerInstance.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { createLSPClient } = await import('../LSPClient.js')
const { createLSPServerManager } = await import('../LSPServerManager.js')

function createHungProcess(): {
  child: ChildProcess
  signals: Array<NodeJS.Signals | number | undefined>
} {
  const emitter = new EventEmitter()
  const signals: Array<NodeJS.Signals | number | undefined> = []
  const state = Object.assign(emitter, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill(signal?: NodeJS.Signals | number): boolean {
      signals.push(signal)
      if (signal === 'SIGKILL') {
        state.signalCode = 'SIGKILL'
        queueMicrotask(() => state.emit('exit', null, 'SIGKILL'))
      }
      return true
    },
  })
  return { child: state as unknown as ChildProcess, signals }
}

test('LSP client times out shutdown, disposes the connection, then escalates TERM to KILL', async () => {
  const { child, signals } = createHungProcess()
  const dispose = mock(() => {})
  const connection = {
    listen: mock(() => {}),
    trace: mock(async () => {}),
    onError: mock(() => {}),
    onClose: mock(() => {}),
    onNotification: mock(() => {}),
    onRequest: mock(() => {}),
    sendNotification: mock(async () => {}),
    sendRequest: mock((method: string) => {
      if (method === 'initialize') {
        return Promise.resolve({ capabilities: {} })
      }
      if (method === 'shutdown') return new Promise<never>(() => {})
      return Promise.reject(new Error(`unexpected request: ${method}`))
    }),
    dispose,
  } as unknown as MessageConnection

  const client = createLSPClient('hung-server', undefined, {
    spawn: (() => {
      queueMicrotask(() => child.emit('spawn'))
      return child
    }) as unknown as typeof import('node:child_process').spawn,
    createMessageConnection: (() =>
      connection) as unknown as typeof import('vscode-jsonrpc/node.js').createMessageConnection,
    shutdownTimeoutMs: 20,
    terminateGraceMs: 20,
  })

  await client.start('unused', [])
  await client.initialize({} as InitializeParams)

  await expect(client.stop()).rejects.toThrow('shutdown timed out after 20ms')
  expect(dispose).toHaveBeenCalledTimes(1)
  expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(client.isInitialized).toBe(false)
})

test('LSP manager bounds a server stop that never settles and still clears state', async () => {
  const manager = createLSPServerManager({ stopTimeoutMs: 20 })
  const hungServer = {
    name: 'hung-server',
    config: {},
    state: 'running',
    startTime: undefined,
    lastError: undefined,
    restartCount: 0,
    start: async () => {},
    stop: () => new Promise<void>(() => {}),
    restart: async () => {},
    isHealthy: () => true,
    sendRequest: async () => undefined,
    sendNotification: async () => {},
    onNotification: () => {},
    onRequest: () => {},
  } as unknown as LSPServerInstance
  manager.getAllServers().set(hungServer.name, hungServer)

  await expect(manager.shutdown()).rejects.toThrow(
    "LSP server 'hung-server' stop timed out after 20ms",
  )
  expect(manager.getAllServers().size).toBe(0)
})
