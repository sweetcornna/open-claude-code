import type { Transport as ModernTransport } from '@modelcontextprotocol/server'
import type { Transport as LegacyTransport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * A transport both SDK generations can drive.
 *
 * The v2 `Transport` interface is a structural superset of the v1 one: it adds
 * only optional members (`hasPerRequestStream`, `setSupportedProtocolVersions`)
 * and optional `send` options (`requestSignal`, `onRequestStreamEnd`,
 * `headers`). Nothing a transport must provide changed, so the two types are
 * mutually assignable and this alias is accepted wherever either SDK asks for
 * a `Transport` — which is what keeps the v1 client working while
 * `occ mcp serve` runs on the v2 server.
 *
 * The alias is the v2 type rather than an intersection on purpose: an
 * intersection of the two generic `onmessage` signatures is an overload set,
 * which silently drops contextual typing for `onmessage = msg => …` callbacks.
 * The v1 side is enforced by `implements LegacyTransport` on the class below,
 * so a future SDK release that breaks the overlap still fails the build.
 */
export type DualEraTransport = ModernTransport

/**
 * In-process linked transport pair for running an MCP server and client
 * in the same process without spawning a subprocess.
 *
 * `send()` on one side delivers to `onmessage` on the other.
 * `close()` on either side calls `onclose` on both.
 *
 * This shares one channel between both peers, so it deliberately leaves
 * `hasPerRequestStream` unset and ignores the per-request `send` options —
 * the v2 spec reserves those for the POST-per-request Streamable HTTP model.
 */
class InProcessTransport implements LegacyTransport, ModernTransport {
  private peer: InProcessTransport | undefined
  private closed = false

  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  /** @internal */
  _setPeer(peer: InProcessTransport): void {
    this.peer = peer
  }

  async start(): Promise<void> {}

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) {
      throw new Error('Transport is closed')
    }
    // Deliver to the other side asynchronously to avoid stack depth issues
    // with synchronous request/response cycles
    queueMicrotask(() => {
      this.peer?.onmessage?.(message)
    })
  }

  async close(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    this.onclose?.()
    // Close the peer if it hasn't already closed
    if (this.peer && !this.peer.closed) {
      this.peer.closed = true
      this.peer.onclose?.()
    }
  }
}

/**
 * Creates a pair of linked transports for in-process MCP communication.
 * Messages sent on one transport are delivered to the other's `onmessage`.
 *
 * @returns [clientTransport, serverTransport]
 */
export function createLinkedTransportPair(): [
  DualEraTransport,
  DualEraTransport,
] {
  const a = new InProcessTransport()
  const b = new InProcessTransport()
  a._setPeer(b)
  b._setPeer(a)
  return [a, b]
}
