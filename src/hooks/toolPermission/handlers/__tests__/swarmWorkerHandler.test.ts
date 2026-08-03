import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../tests/mocks/debug.js'
import { logMock } from '../../../../../tests/mocks/log.js'
import type { PermissionResponseCallback } from '../../../useSwarmPermissionPoller.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

const { _test } = await import('../swarmWorkerHandler.js')

type WaitParams = Parameters<typeof _test.waitForLeaderPermissionDecision>[0]
type PermissionRequest = Parameters<
  typeof _test.waitForLeaderPermissionDecision
>[1]

function createParams(abortController = new AbortController()): {
  params: WaitParams
  getPending: () => unknown
  cancelDecision: {
    behavior: 'deny'
    message: string
    decisionReason: { type: 'mode'; mode: 'default' }
  }
} {
  let state: Record<string, unknown> = { pendingWorkerRequest: null }
  const cancelDecision = {
    behavior: 'deny' as const,
    message: 'cancelled',
    decisionReason: { type: 'mode' as const, mode: 'default' as const },
  }
  const ctx = {
    tool: { name: 'Bash' },
    toolUseID: 'tool-1',
    input: { command: 'pwd' },
    toolUseContext: {
      abortController,
      setAppState(
        updater: (prev: Record<string, unknown>) => Record<string, unknown>,
      ) {
        state = updater(state)
      },
    },
    handleUserAllow: async () => ({ behavior: 'allow' as const }),
    cancelAndAbort: () => cancelDecision,
    logDecision: () => {},
    logCancelled: () => {},
  }

  return {
    params: {
      ctx,
      description: 'Run pwd',
      updatedInput: undefined,
      suggestions: undefined,
    } as unknown as WaitParams,
    getPending: () => state.pendingWorkerRequest,
    cancelDecision,
  }
}

const REQUEST = { id: 'request-1' } as PermissionRequest

describe('swarm worker permission lifecycle', () => {
  test('send failure unregisters the callback and falls back locally', async () => {
    const { params, getPending } = createParams()
    const unregistered: string[] = []

    const result = await _test.waitForLeaderPermissionDecision(
      params,
      REQUEST,
      {
        registerPermissionCallback: () => {},
        unregisterPermissionCallback: requestId => {
          unregistered.push(requestId)
        },
        sendPermissionRequestViaMailbox: async () => false,
      },
    )

    expect(result).toBeNull()
    expect(unregistered).toEqual(['request-1'])
    expect(getPending()).toBeNull()
  })

  test('abort unregisters the callback and resolves the pending request', async () => {
    const abortController = new AbortController()
    const { params, getPending, cancelDecision } = createParams(abortController)
    const unregistered: string[] = []
    let finishSend: ((sent: boolean) => void) | undefined
    const sendPromise = new Promise<boolean>(resolve => {
      finishSend = resolve
    })

    const decisionPromise = _test.waitForLeaderPermissionDecision(
      params,
      REQUEST,
      {
        registerPermissionCallback: () => {},
        unregisterPermissionCallback: requestId => {
          unregistered.push(requestId)
        },
        sendPermissionRequestViaMailbox: () => sendPromise,
      },
    )

    abortController.abort()

    expect(await decisionPromise).toBe(cancelDecision)
    expect(unregistered).toEqual(['request-1'])
    expect(getPending()).toBeNull()
    finishSend?.(true)
  })

  test('allow response also unregisters before resolving', async () => {
    const { params, getPending } = createParams()
    const unregistered: string[] = []
    let callback: PermissionResponseCallback | undefined

    const decisionPromise = _test.waitForLeaderPermissionDecision(
      params,
      REQUEST,
      {
        registerPermissionCallback: value => {
          callback = value
        },
        unregisterPermissionCallback: requestId => {
          unregistered.push(requestId)
        },
        sendPermissionRequestViaMailbox: async () => true,
      },
    )

    await Promise.resolve(callback?.onAllow(undefined, []))

    expect(await decisionPromise).toEqual({ behavior: 'allow' })
    expect(unregistered).toEqual(['request-1'])
    expect(getPending()).toBeNull()
  })
})
