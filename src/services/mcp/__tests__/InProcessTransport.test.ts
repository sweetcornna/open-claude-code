import type { Transport as ModernTransport } from '@modelcontextprotocol/server'
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, test } from 'bun:test'
import { createLinkedTransportPair } from '../InProcessTransport.js'

const REQUEST: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'tools/list',
  params: {},
  id: 1,
}

/** Lets a queueMicrotask-deferred delivery land. */
const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('createLinkedTransportPair', () => {
  test('satisfies both the v1 and the v2 SDK Transport contract', () => {
    const [clientSide, serverSide] = createLinkedTransportPair()

    // Compile-time: the same object is accepted wherever either SDK
    // generation asks for a Transport, with no cast.
    const asLegacy: LegacyTransport = clientSide
    const asModern: ModernTransport = serverSide

    expect(typeof asLegacy.start).toBe('function')
    expect(typeof asLegacy.send).toBe('function')
    expect(typeof asLegacy.close).toBe('function')
    // Single-channel transports leave the v2-only per-request-stream flag
    // unset; the protocol layer then cancels via notifications/cancelled
    // rather than aborting a per-request signal.
    expect(asModern.hasPerRequestStream).toBeUndefined()
  })

  test('round-trips a message from client to server', async () => {
    const [clientSide, serverSide] = createLinkedTransportPair()
    const received: JSONRPCMessage[] = []
    serverSide.onmessage = message => {
      received.push(message)
    }

    await clientSide.start()
    await clientSide.send(REQUEST)
    await flush()

    expect(received).toEqual([REQUEST])
  })

  test('round-trips a message from server to client', async () => {
    const [clientSide, serverSide] = createLinkedTransportPair()
    const received: JSONRPCMessage[] = []
    clientSide.onmessage = message => {
      received.push(message)
    }

    const response: JSONRPCMessage = { jsonrpc: '2.0', result: {}, id: 1 }
    await serverSide.send(response)
    await flush()

    expect(received).toEqual([response])
  })

  test('propagates close to both peers exactly once', async () => {
    const [clientSide, serverSide] = createLinkedTransportPair()
    let clientCloses = 0
    let serverCloses = 0
    clientSide.onclose = () => {
      clientCloses++
    }
    serverSide.onclose = () => {
      serverCloses++
    }

    await clientSide.close()
    // Closing the peer afterwards must not re-fire either callback.
    await serverSide.close()
    await clientSide.close()

    expect(clientCloses).toBe(1)
    expect(serverCloses).toBe(1)
  })

  test('surfaces a send on a closed transport as a rejection', async () => {
    const [clientSide, serverSide] = createLinkedTransportPair()
    await clientSide.close()

    expect(clientSide.send(REQUEST)).rejects.toThrow('Transport is closed')
    // The peer was closed by propagation, so it rejects too.
    expect(serverSide.send(REQUEST)).rejects.toThrow('Transport is closed')
  })

  test('stops delivering messages after close', async () => {
    const [clientSide, serverSide] = createLinkedTransportPair()
    const received: JSONRPCMessage[] = []
    serverSide.onmessage = message => {
      received.push(message)
    }

    await clientSide.send(REQUEST)
    await clientSide.close()
    await flush()

    expect(received).toEqual([REQUEST])
  })
})
