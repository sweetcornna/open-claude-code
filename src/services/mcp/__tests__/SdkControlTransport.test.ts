import type { Transport as ModernTransport } from '@modelcontextprotocol/server'
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, test } from 'bun:test'
import {
  SdkControlClientTransport,
  SdkControlServerTransport,
} from '../SdkControlTransport.js'

const REQUEST: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'tools/call',
  params: { name: 'Glob' },
  id: 7,
}
const RESPONSE: JSONRPCMessage = { jsonrpc: '2.0', result: { ok: true }, id: 7 }

describe('SdkControlClientTransport', () => {
  test('satisfies both the v1 and the v2 SDK Transport contract', () => {
    const transport = new SdkControlClientTransport('srv', async () => RESPONSE)

    const asLegacy: LegacyTransport = transport
    const asModern: ModernTransport = transport

    expect(typeof asLegacy.start).toBe('function')
    // Bridged over a single control channel, so the v2-only per-request-stream
    // flag stays unset.
    expect(asModern.hasPerRequestStream).toBeUndefined()
  })

  test('round-trips a request through the control channel', async () => {
    const sent: { serverName: string; message: JSONRPCMessage }[] = []
    const transport = new SdkControlClientTransport(
      'sdk-server',
      async (serverName, message) => {
        sent.push({ serverName, message })
        return RESPONSE
      },
    )
    const received: JSONRPCMessage[] = []
    transport.onmessage = message => {
      received.push(message)
    }

    await transport.start()
    await transport.send(REQUEST)

    expect(sent).toEqual([{ serverName: 'sdk-server', message: REQUEST }])
    expect(received).toEqual([RESPONSE])
  })

  test('fires onclose exactly once', async () => {
    const transport = new SdkControlClientTransport('srv', async () => RESPONSE)
    let closes = 0
    transport.onclose = () => {
      closes++
    }

    await transport.close()
    await transport.close()

    expect(closes).toBe(1)
  })

  test('surfaces a send on a closed transport as a rejection', async () => {
    const transport = new SdkControlClientTransport('srv', async () => RESPONSE)
    await transport.close()

    expect(transport.send(REQUEST)).rejects.toThrow('Transport is closed')
  })

  test('surfaces a failing control channel to the caller', async () => {
    const transport = new SdkControlClientTransport('srv', async () => {
      throw new Error('control channel down')
    })
    const received: JSONRPCMessage[] = []
    transport.onmessage = message => {
      received.push(message)
    }

    expect(transport.send(REQUEST)).rejects.toThrow('control channel down')
    expect(received).toEqual([])
  })
})

describe('SdkControlServerTransport', () => {
  test('satisfies both the v1 and the v2 SDK Transport contract', () => {
    const transport = new SdkControlServerTransport(() => {})

    const asLegacy: LegacyTransport = transport
    const asModern: ModernTransport = transport

    expect(typeof asLegacy.send).toBe('function')
    expect(asModern.hasPerRequestStream).toBeUndefined()
  })

  test('forwards outbound messages to the control callback', async () => {
    const sent: JSONRPCMessage[] = []
    const transport = new SdkControlServerTransport(message => {
      sent.push(message)
    })

    await transport.start()
    await transport.send(RESPONSE)

    expect(sent).toEqual([RESPONSE])
  })

  test('delivers inbound control requests to the server', async () => {
    const transport = new SdkControlServerTransport(() => {})
    const received: JSONRPCMessage[] = []
    transport.onmessage = message => {
      received.push(message)
    }

    transport.onmessage?.(REQUEST)

    expect(received).toEqual([REQUEST])
  })

  test('fires onclose exactly once', async () => {
    const transport = new SdkControlServerTransport(() => {})
    let closes = 0
    transport.onclose = () => {
      closes++
    }

    await transport.close()
    await transport.close()

    expect(closes).toBe(1)
  })

  test('surfaces a send on a closed transport as a rejection', async () => {
    const transport = new SdkControlServerTransport(() => {})
    await transport.close()

    expect(transport.send(RESPONSE)).rejects.toThrow('Transport is closed')
  })
})
