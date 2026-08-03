import { afterEach, describe, expect, test } from 'bun:test'
import { parseSSEFrames, SSETransport } from '../SSETransport.js'

if (typeof globalThis.MACRO === 'undefined') {
  ;(globalThis as unknown as { MACRO: { VERSION: string } }).MACRO = {
    VERSION: 'test',
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('parseSSEFrames', () => {
  test('parses LF-delimited frames', () => {
    const input = 'event: client_event\ndata: {"ok":true}\n\n'
    const { frames, remaining } = parseSSEFrames(input)

    expect(remaining).toBe('')
    expect(frames).toEqual([
      {
        event: 'client_event',
        data: '{"ok":true}',
      },
    ])
  })

  test('parses CRLF-delimited frames and strips trailing carriage returns', () => {
    const input =
      'event: client_event\r\ndata: {"ok":true}\r\nid: 7\r\n\r\nevent: keepalive\r\ndata: ping\r\n\r\n'
    const { frames, remaining } = parseSSEFrames(input)

    expect(remaining).toBe('')
    expect(frames).toEqual([
      {
        event: 'client_event',
        data: '{"ok":true}',
        id: '7',
      },
      {
        event: 'keepalive',
        data: 'ping',
      },
    ])
  })

  test('keeps incomplete trailing frame in remaining buffer for CRLF streams', () => {
    const input =
      'event: client_event\r\ndata: {"ok":true}\r\n\r\ndata: {"tail":1}\r\n'
    const { frames, remaining } = parseSSEFrames(input)

    expect(frames).toEqual([
      {
        event: 'client_event',
        data: '{"ok":true}',
      },
    ])
    expect(remaining).toBe('data: {"tail":1}\r\n')
  })
})

describe('SSETransport liveness', () => {
  test('counts a liveness timeout as one connection failure', async () => {
    globalThis.fetch = (async (_input, init) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new DOMException('Aborted', 'AbortError'))
          })
        },
      })
      return new Response(body, { status: 200 })
    }) as typeof globalThis.fetch

    const transport = new SSETransport(
      new URL('https://example.test/events/stream'),
      {},
      undefined,
      undefined,
      undefined,
      () => ({ Authorization: 'Bearer test' }),
    )
    const connectPromise = transport.connect()

    const deadline = Date.now() + 1000
    while (!transport.isConnectedStatus() && Date.now() < deadline) {
      await Bun.sleep(5)
    }
    expect(transport.isConnectedStatus()).toBe(true)

    const internals = transport as unknown as {
      onLivenessTimeout(): void
      reconnectAttempts: number
    }
    internals.onLivenessTimeout()
    await connectPromise

    expect(internals.reconnectAttempts).toBe(1)
    transport.close()
  })
})
