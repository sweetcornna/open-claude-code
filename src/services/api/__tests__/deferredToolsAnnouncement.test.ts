/**
 * The ephemeral `<available-deferred-tools>` announcement.
 *
 * This is no longer the default path — deferred tools are announced once via a
 * persisted `deferred_tools_delta` attachment, because the ephemeral copy was
 * regenerated per request and the single message-level cache_control marker
 * landed on it, so every turn wrote a cache entry that could never be read.
 * The code below is the CLAUDE_CODE_DEFERRED_TOOLS_DELTA=0 fallback; the
 * "same pool every request" behavior it pins is deliberate *for that mode*.
 *
 * Which mode a request takes is decided by
 * `shouldAppendEphemeralDeferredToolList`, covered in
 * src/utils/tools/__tests__/deferredToolsDelta.test.ts.
 */
import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { appendAvailableDeferredToolsForAnthropicRequest } = await import(
  '../claude.js'
)

const deferredTools = [
  { name: 'mcp__calendar__create_event' },
  { name: 'CronCreate' },
  { name: 'Read' },
] as never
const deferredToolNames = new Set(['CronCreate', 'mcp__calendar__create_event'])

function getAnnouncement(
  request: ReturnType<typeof appendAvailableDeferredToolsForAnthropicRequest>,
): string {
  const message = request.at(-1)
  const content = message?.message.content
  if (typeof content !== 'string') {
    throw new Error('Expected a deferred-tools announcement')
  }
  return content
}

describe('Anthropic deferred-tool announcements', () => {
  test('includes the complete unchanged pool in consecutive requests', () => {
    const persistedHistory: Parameters<
      typeof appendAvailableDeferredToolsForAnthropicRequest
    >[0] = []

    const firstRequest = appendAvailableDeferredToolsForAnthropicRequest(
      persistedHistory,
      deferredTools,
      deferredToolNames,
    )
    const secondRequest = appendAvailableDeferredToolsForAnthropicRequest(
      persistedHistory,
      deferredTools,
      deferredToolNames,
    )

    for (const request of [firstRequest, secondRequest]) {
      const announcement = getAnnouncement(request)
      expect(announcement).toContain(
        '<available-deferred-tools>\nCronCreate\nmcp__calendar__create_event\n</available-deferred-tools>',
      )
      expect(announcement).not.toContain('\nRead\n')
    }
  })

  test('includes the pool on a new session first request in the same process', () => {
    const firstSession = appendAvailableDeferredToolsForAnthropicRequest(
      [
        {
          type: 'user',
          uuid: 'session-one',
          message: { role: 'user', content: 'first session' },
        },
      ] as never,
      deferredTools,
      deferredToolNames,
    )
    const newSession = appendAvailableDeferredToolsForAnthropicRequest(
      [
        {
          type: 'user',
          uuid: 'session-two',
          message: { role: 'user', content: 'new session' },
        },
      ] as never,
      deferredTools,
      deferredToolNames,
    )

    expect(getAnnouncement(firstSession)).toContain('CronCreate')
    expect(getAnnouncement(newSession)).toContain('CronCreate')
    expect(newSession).toHaveLength(2)
  })
})

/**
 * Why the ephemeral path was demoted, stated as a property of the message array
 * rather than prose.
 *
 * addCacheBreakpoints places exactly one message-level cache_control marker,
 * at `messages.length - 1`. This announcement is appended to the tail and never
 * written back to history, so it OWNS that index — every cache write aims at a
 * prefix whose last block cannot recur, and the entry is never read back.
 *
 * (Asserting the marker itself would mean importing addCacheBreakpoints, which
 * reaches auth.ts for the 1h-TTL decision; mocking auth here would install a
 * process-global override on every later file in this shard.)
 */
describe('the ephemeral announcement owns the cache-marker index', () => {
  test('it is appended last, where the single marker goes', () => {
    const history = [
      {
        type: 'user',
        uuid: 'u1',
        message: { role: 'user', content: 'do the thing' },
      },
    ] as never as Parameters<
      typeof appendAvailableDeferredToolsForAnthropicRequest
    >[0]

    const withAnnouncement = appendAvailableDeferredToolsForAnthropicRequest(
      history,
      deferredTools,
      deferredToolNames,
    )

    expect(withAnnouncement).toHaveLength(history.length + 1)
    expect(getAnnouncement(withAnnouncement)).toContain(
      '<available-deferred-tools>',
    )
    // Nothing else moved — the original turn keeps its position.
    expect(withAnnouncement[0]).toBe(history[0]!)
  })
})
