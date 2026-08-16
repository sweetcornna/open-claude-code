import { Buffer } from 'node:buffer'
import type { WSContext } from 'hono/ws'
import { error as logError } from '../logger'

const textDecoder = new TextDecoder()

const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024

type DecodedWsMessage =
  | { ok: true; data: string; size: number }
  | { ok: false; reason: string; size?: number }

function decodeWsPayload(data: unknown): DecodedWsMessage {
  if (typeof data === 'string') {
    return { ok: true, data, size: Buffer.byteLength(data, 'utf8') }
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > MAX_WS_MESSAGE_SIZE) {
      return { ok: false, reason: 'message too large', size: data.byteLength }
    }
    return { ok: true, data: textDecoder.decode(data), size: data.byteLength }
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength > MAX_WS_MESSAGE_SIZE) {
      return { ok: false, reason: 'message too large', size: data.byteLength }
    }
    return { ok: true, data: textDecoder.decode(data), size: data.byteLength }
  }
  if (
    typeof SharedArrayBuffer !== 'undefined' &&
    data instanceof SharedArrayBuffer
  ) {
    const bytes = new Uint8Array(data)
    if (bytes.byteLength > MAX_WS_MESSAGE_SIZE) {
      return { ok: false, reason: 'message too large', size: bytes.byteLength }
    }
    return { ok: true, data: textDecoder.decode(bytes), size: bytes.byteLength }
  }
  return { ok: false, reason: typeof data }
}

export function handleSizedWsPayload(
  ws: WSContext,
  logPrefix: string,
  label: string,
  payload: unknown,
  handleMessage: (data: string) => void,
): boolean {
  const decoded = decodeWsPayload(payload)
  if (!decoded.ok) {
    if (decoded.reason === 'message too large' && decoded.size !== undefined) {
      logError(
        `${logPrefix} Message too large on ${label}: size=${decoded.size} limit=${MAX_WS_MESSAGE_SIZE}`,
      )
      ws.close(1009, 'message too large')
      return false
    }
    logError(
      `${logPrefix} Unsupported message payload on ${label}: ${decoded.reason}`,
    )
    ws.close(1003, 'unsupported message payload')
    return false
  }
  if (decoded.size > MAX_WS_MESSAGE_SIZE) {
    logError(
      `${logPrefix} Message too large on ${label}: size=${decoded.size} limit=${MAX_WS_MESSAGE_SIZE}`,
    )
    ws.close(1009, 'message too large')
    return false
  }
  return runWsMessageHandler(ws, logPrefix, label, () =>
    handleMessage(decoded.data),
  )
}

/**
 * Last-resort boundary around a WebSocket message handler.
 *
 * Bun dispatches `message` callbacks outside any request context: an exception
 * that escapes one is an unhandled rejection that takes the whole process
 * down, killing every other tenant's connections with it. That is exactly what
 * a per-account quota breach used to do — `registerEnvironment` throws, nobody
 * catches, the server exits and `/health` stops answering.
 *
 * The frame is dropped and the socket stays open; the peer gets a generic
 * error frame with no stack and no internals.
 */
function runWsMessageHandler(
  ws: WSContext,
  logPrefix: string,
  label: string,
  handle: () => void,
): boolean {
  try {
    handle()
    return true
  } catch (error) {
    logError(`${logPrefix} Handler error on ${label}:`, error)
    try {
      if (ws.readyState === 1) {
        ws.send(
          JSON.stringify({ type: 'error', message: 'Internal server error' }) +
            '\n',
        )
      }
    } catch {
      // The socket is already gone; nothing left to report to.
    }
    return false
  }
}
