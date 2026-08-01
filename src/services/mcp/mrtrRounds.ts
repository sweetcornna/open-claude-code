/**
 * Round tracking for multi-round-trip (MRTR) tool calls, protocol revision
 * 2026-07-28.
 *
 * On the modern era a server no longer SENDS `elicitation/create` as a
 * server→client request — that channel does not exist. It answers `tools/call`
 * with an `input_required` result carrying the elicitation embedded, and the
 * SDK's auto-fulfilment driver dispatches it to the client's registered
 * handler and retries the call, up to `inputRequired.maxRounds` (10) rounds.
 * The opaque `requestState` is echoed back verbatim on each retry by the
 * driver itself; nothing in this file participates in that, and nothing here
 * may ever influence what goes on the wire.
 *
 * What the driver does NOT give the handler is any notion of WHICH round it is
 * being asked in: the synthesized handler context carries the `inputRequests`
 * key as its id (correlation only — the same key repeats every round) and its
 * `requestState` accessor is always empty on the client side. The one channel
 * that reports rounds is the originating call's `onprogress`, which the driver
 * invokes directly — not through a progress notification — at the top of each
 * round, BEFORE dispatching that round's embedded requests. That ordering is
 * what makes {@link currentMrtrRound} correct to read from inside an
 * elicitation handler.
 *
 * This is display-only. A wrong or missing round number costs a line of dialog
 * chrome and nothing else.
 */

import type { Client } from '@modelcontextprotocol/client'

/**
 * The driver's per-round progress message.
 *
 * The round number is not carried in a structured field, so recovering it
 * means matching the SDK's own formatter. An SDK release that reworded this
 * would silently stop producing round numbers, which is why
 * `negotiationMatrix.test.ts` drives a real multi-round exchange through the
 * real driver and asserts the rounds arrive: the pin fails loudly on upgrade
 * instead of the counter quietly disappearing in production.
 */
const DRIVER_ROUND_MESSAGE =
  /^Fulfilling input required by '[^']*' \(round (\d+)\)$/

/** The progress shape both the SDK driver and server notifications deliver. */
export type McpProgressEvent = {
  progress?: number
  total?: number
  message?: string
}

/**
 * The 1-based round a progress event reports, or `undefined` when the event is
 * ordinary server progress rather than the driver's round marker.
 */
function parseMrtrRound(event: McpProgressEvent): number | undefined {
  const { message } = event
  if (message === undefined) return undefined
  const match = DRIVER_ROUND_MESSAGE.exec(message)
  if (match === null) return undefined
  const round = Number(match[1])
  return Number.isSafeInteger(round) && round > 0 ? round : undefined
}

/**
 * Keyed by the client rather than by server name: a server name is a host-side
 * label that says nothing about which connection produced the progress, and a
 * `WeakMap` cannot outlive the connection it describes.
 */
const roundByClient = new WeakMap<Client, number>()

/**
 * Whether this connection can produce MRTR rounds at all.
 *
 * The era is a property of the CONNECTION, not of the build — a client
 * compiled with `MCP_2026` still lands on `'legacy'` against a 2025 server,
 * and a legacy connection has no driver, so any progress message shaped like
 * the driver's is the server's own text and must not become a round number.
 */
function isMrtrCapable(client: Client): boolean {
  return client.getProtocolEra() === 'modern'
}

/** Records a round marker; ordinary progress events are ignored. */
function noteMcpProgress(client: Client, event: McpProgressEvent): void {
  if (!isMrtrCapable(client)) return
  const round = parseMrtrRound(event)
  if (round !== undefined) {
    roundByClient.set(client, round)
  }
}

/**
 * The round the in-flight call on this connection is currently fulfilling, or
 * `undefined` outside a multi-round exchange.
 */
export function currentMrtrRound(client: Client): number | undefined {
  return roundByClient.get(client)
}

/**
 * Drops the tracked round. Call sites MUST do this when the originating call
 * settles, otherwise a later, unrelated elicitation on the same connection
 * inherits a stale round number.
 */
export function clearMrtrRound(client: Client): void {
  roundByClient.delete(client)
}

/**
 * The `onprogress` a tool call should install, or `undefined` when none is
 * needed.
 *
 * Returning `undefined` is load-bearing, not an optimisation: the SDK attaches
 * `_meta.progressToken` to a request IFF `onprogress` is set, so installing a
 * tracker unconditionally would start advertising a progress token on every
 * tool call to every server — including legacy-era connections that have no
 * driver to report rounds and servers that begin streaming progress the moment
 * a token appears. The tracker is installed only where it can pay for itself:
 * on a modern-era connection, or when the caller wanted progress anyway.
 */
export function mrtrProgressCallback(
  client: Client,
  forward?: (event: McpProgressEvent) => void,
): ((event: McpProgressEvent) => void) | undefined {
  if (forward === undefined && !isMrtrCapable(client)) return undefined
  return event => {
    noteMcpProgress(client, event)
    forward?.(event)
  }
}
