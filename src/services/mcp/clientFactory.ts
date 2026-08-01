/**
 * The single place an MCP protocol client is constructed.
 *
 * Every `new Client(...)` on the client path goes through here so the
 * era-negotiation posture is decided in exactly one spot. The v2 SDK's
 * default is LEGACY: absent `versionNegotiation`, `connect()` runs the plain
 * 2025 `initialize` handshake, byte-identical to the v1 client. Opting into
 * protocol revision 2026-07-28 is therefore an explicit act, gated by the
 * compiled `MCP_2026` feature flag (see `scripts/defines.ts`).
 *
 * Everything downstream of this module is era-agnostic: it asks the connected
 * client `getProtocolEra()` when behaviour genuinely has to differ, instead of
 * branching on the flag again.
 */

import { feature } from 'bun:bundle'
import {
  Client,
  type ClientCapabilities,
  type Implementation,
  type ProtocolEra,
  type VersionNegotiationOptions,
} from '@modelcontextprotocol/client'
import { PRODUCT_URL } from '../../constants/product.js'

/**
 * The modern protocol revision. Reachable ONLY via `server/discover` — it is
 * deliberately absent from `SUPPORTED_PROTOCOL_VERSIONS` and from the
 * `initialize` version list, so a legacy handshake can never land on it.
 */
export const MCP_MODERN_PROTOCOL_VERSION = '2026-07-28'

/**
 * The negotiation posture this build ships with.
 *
 * `undefined` means "say nothing", which the SDK reads as `mode: 'legacy'` —
 * no probe, no 2026 headers, the exact wire traffic of the pre-migration
 * client. With `MCP_2026` compiled in, `connect()` probes with
 * `server/discover` first and falls back to `initialize` for anything that is
 * not definitive modern evidence.
 *
 * Note the cost of the on-state: one extra round trip per connect, and on the
 * SDK's own stdio transport one extra short-lived child process (the probe
 * runs on a disposable sibling so a server that dies on an unknown
 * pre-`initialize` request is still just a legacy server).
 */
export function defaultMcpVersionNegotiation():
  | VersionNegotiationOptions
  | undefined {
  if (feature('MCP_2026')) {
    return { mode: 'auto' }
  }
  return undefined
}

/** The `clientInfo` every occ-originated MCP client identifies itself with. */
export function mcpClientIdentity(): Implementation {
  return {
    name: 'claude-code',
    title: 'Claude Code',
    version: MACRO.VERSION ?? 'unknown',
    description: "Anthropic's agentic coding tool",
    websiteUrl: PRODUCT_URL,
  }
}

export type CreateMcpClientOptions = {
  /** Capabilities to advertise. Defaults to none. */
  capabilities?: ClientCapabilities
  /**
   * Overrides {@link defaultMcpVersionNegotiation}.
   *
   * This is the seam the negotiation tests drive: `feature()` is resolved at
   * compile time and is always `false` under `bun test`, so the modern-era
   * construction path is unreachable through the flag there. Passing
   * `{ mode: 'auto' }` / `{ mode: { pin: MCP_MODERN_PROTOCOL_VERSION } }`
   * exercises the same code the flag would have selected.
   *
   * Pass `{ mode: 'legacy' }` to pin legacy regardless of the build flag.
   */
  versionNegotiation?: VersionNegotiationOptions
  /** Overrides for the advertised `clientInfo`. */
  info?: Partial<Implementation>
}

/**
 * Constructs an MCP protocol client with this build's negotiation posture.
 */
export function createMcpClient(options: CreateMcpClientOptions = {}): Client {
  const versionNegotiation =
    options.versionNegotiation ?? defaultMcpVersionNegotiation()

  return new Client(
    { ...mcpClientIdentity(), ...options.info },
    {
      capabilities: options.capabilities ?? {},
      // Omit the key entirely when there is no posture to declare: the SDK
      // treats absent and `{ mode: 'legacy' }` the same, and omitting keeps
      // the constructed options identical to the pre-migration call.
      ...(versionNegotiation ? { versionNegotiation } : {}),
    },
  )
}

/**
 * The era a connected client negotiated, or `undefined` before connect.
 */
export function mcpProtocolEra(client: Client): ProtocolEra | undefined {
  return client.getProtocolEra()
}

/**
 * True once the connection has negotiated protocol revision 2026-07-28 or
 * later. The era is a property of the CONNECTION, not of the build: a client
 * compiled with `MCP_2026` still lands on `'legacy'` against a 2025 server.
 */
export function isModernMcpEra(client: Client): boolean {
  return client.getProtocolEra() === 'modern'
}
