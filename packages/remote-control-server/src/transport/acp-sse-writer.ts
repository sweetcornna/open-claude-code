import { log } from '../logger'
import type { Context } from 'hono'
import type { SessionEvent } from './event-bus'
import { getAcpEventBus } from './event-bus'
import { attachStreamGuard, type StreamGuard } from './connection-registry'
import { endGuardedStream } from './sse-writer'

/** Create SSE response stream for an ACP channel group */
export function createAcpSSEStream(
  c: Context,
  accountId: string,
  channelGroupId: string,
  fromSeqNum = 0,
  guard?: StreamGuard,
) {
  const bus = getAcpEventBus(accountId, channelGroupId)

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
            channel_group_id: channelGroupId,
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
          channel_group_id: channelGroupId,
        })
        try {
          log(
            `[ACP-SSE] -> subscriber: channelGroup=${channelGroupId} type=${event.type} seq=${event.seqNum}`,
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

      // Keepalive interval — doubles as the credential revalidation tick.
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
