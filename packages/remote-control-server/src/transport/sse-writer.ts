import { log, error as logError } from '../logger'
import type { Context } from 'hono'
import type { SessionEvent } from './event-bus'
import { getEventBus } from './event-bus'
import { toClientPayload } from './client-payload'
import { attachStreamGuard, type StreamGuard } from './connection-registry'

/**
 * Emit a terminal frame and end the stream. SSE clients auto-reconnect, and
 * the reconnect carries the same (now dead) credential, so the reason is
 * spelled out in-band to let the client stop instead of hot-looping.
 */
export function endGuardedStream(
  controller: ReadableStreamDefaultController,
  encoder: TextEncoder,
  reason: string,
): void {
  try {
    controller.enqueue(
      encoder.encode(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`),
    )
  } catch {
    // Stream already torn down by the client.
  }
  try {
    controller.close()
  } catch {
    // Already closed.
  }
}

interface SSEWriter {
  send(event: SessionEvent): void
  close(): void
}

interface SSEWriterState {
  encoder: TextEncoder
  controller: ReadableStreamDefaultController
}

const writerStates = new WeakMap<Context, SSEWriterState>()

export function createSSEWriter(c: Context): SSEWriter {
  const stream = new ReadableStream({
    start(controller) {
      writerStates.set(c, { encoder: new TextEncoder(), controller })
      c.req.raw.signal.addEventListener('abort', () => {
        writerStates.delete(c)
        controller.close()
      })
    },
  })

  return {
    send(event: SessionEvent) {
      const state = writerStates.get(c)
      if (!state) return
      const data = JSON.stringify({
        type: event.type,
        payload: event.payload,
        direction: event.direction,
        seqNum: event.seqNum,
      })
      const msg = `id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`
      state.controller.enqueue(state.encoder.encode(msg))
    },
    close() {
      const state = writerStates.get(c)
      writerStates.delete(c)
      state?.controller.close()
    },
  }
}

/**
 * Create SSE response stream for a session.
 *
 * `guard` is what keeps the stream honest after the fact: the request
 * authenticated once, but a browser that logs out (or whose cookie is revoked)
 * previously kept receiving events on the already-open EventSource.
 */
export function createSSEStream(
  c: Context,
  sessionId: string,
  fromSeqNum = 0,
  guard?: StreamGuard,
) {
  const bus = getEventBus(sessionId)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let unsub: () => void = () => {}
      let keepalive: ReturnType<typeof setInterval> | undefined
      const streamGuard = attachStreamGuard(guard, reason => {
        unsub()
        if (keepalive) clearInterval(keepalive)
        endGuardedStream(controller, encoder, reason)
      })

      // Send historical events if reconnecting
      if (fromSeqNum > 0) {
        const missed = bus.getEventsSince(fromSeqNum)
        for (const event of missed) {
          const data = JSON.stringify({
            type: event.type,
            payload: event.payload,
            direction: event.direction,
            seqNum: event.seqNum,
          })
          controller.enqueue(
            encoder.encode(
              `id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`,
            ),
          )
        }
      }

      // Send initial keepalive
      controller.enqueue(encoder.encode(': keepalive\n\n'))

      // Subscribe to new events
      unsub = bus.subscribe(event => {
        if (!streamGuard.ensureValid()) return
        const data = JSON.stringify({
          type: event.type,
          payload: event.payload,
          direction: event.direction,
          seqNum: event.seqNum,
        })
        try {
          log(
            `[RC-DEBUG] SSE -> web: sessionId=${sessionId} type=${event.type} dir=${event.direction} seq=${event.seqNum}`,
          )
          controller.enqueue(
            encoder.encode(
              `id: ${event.seqNum}\nevent: message\ndata: ${data}\n\n`,
            ),
          )
        } catch {
          unsub()
        }
      })

      // Keepalive interval — also the revalidation tick, so a stream with no
      // traffic still notices an expired credential within one interval.
      keepalive = setInterval(() => {
        if (!streamGuard.ensureValid()) return
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          if (keepalive) clearInterval(keepalive)
          unsub()
        }
      }, 15000)

      // Cleanup on abort
      c.req.raw.signal.addEventListener('abort', () => {
        unsub()
        if (keepalive) clearInterval(keepalive)
        streamGuard.dispose()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

function toWorkerClientPayload(event: SessionEvent): Record<string, unknown> {
  if (
    event.type === 'permission_response' ||
    event.type === 'control_response' ||
    event.type === 'control_request' ||
    event.type === 'interrupt'
  ) {
    return toClientPayload(event)
  }

  const normalized =
    event.payload && typeof event.payload === 'object'
      ? (event.payload as Record<string, unknown>)
      : undefined
  const raw =
    normalized?.raw &&
    typeof normalized.raw === 'object' &&
    !Array.isArray(normalized.raw)
      ? (normalized.raw as Record<string, unknown>)
      : undefined
  const payload: Record<string, unknown> = {
    ...(raw ?? normalized ?? {}),
    type: event.type,
  }

  if (event.type === 'user') {
    const message = payload.message
    if (!message || typeof message !== 'object' || !('content' in message)) {
      const content =
        typeof normalized?.content === 'string'
          ? normalized.content
          : typeof payload.content === 'string'
            ? payload.content
            : typeof event.payload === 'string'
              ? event.payload
              : ''
      payload.content = content
      payload.message = { content }
    }
  }

  return payload
}

function toWorkerClientFrame(event: SessionEvent): string {
  const data = JSON.stringify({
    event_id: event.id,
    sequence_num: event.seqNum,
    event_type: event.type,
    source: 'client',
    payload: toWorkerClientPayload(event),
    created_at: new Date(event.createdAt).toISOString(),
  })
  return `id: ${event.seqNum}\nevent: client_event\ndata: ${data}\n\n`
}

/** Create CCR worker SSE stream (client_event frames, outbound events only). */
export function createWorkerEventStream(
  c: Context,
  sessionId: string,
  fromSeqNum = 0,
  guard?: StreamGuard,
) {
  const bus = getEventBus(sessionId)

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let unsub: () => void = () => {}
      let keepalive: ReturnType<typeof setInterval> | undefined
      const streamGuard = attachStreamGuard(guard, reason => {
        unsub()
        if (keepalive) clearInterval(keepalive)
        endGuardedStream(controller, encoder, reason)
      })

      if (fromSeqNum > 0) {
        const missed = bus
          .getEventsSince(fromSeqNum)
          .filter(event => event.direction === 'outbound')
        for (const event of missed) {
          controller.enqueue(encoder.encode(toWorkerClientFrame(event)))
        }
      }

      controller.enqueue(encoder.encode(': keepalive\n\n'))

      unsub = bus.subscribe(event => {
        if (event.direction !== 'outbound') {
          return
        }
        if (!streamGuard.ensureValid()) return
        try {
          controller.enqueue(encoder.encode(toWorkerClientFrame(event)))
        } catch {
          unsub()
        }
      })

      keepalive = setInterval(() => {
        if (!streamGuard.ensureValid()) return
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          if (keepalive) clearInterval(keepalive)
          unsub()
        }
      }, 15000)

      c.req.raw.signal.addEventListener('abort', () => {
        unsub()
        if (keepalive) clearInterval(keepalive)
        streamGuard.dispose()
        try {
          controller.close()
        } catch {
          // already closed
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
