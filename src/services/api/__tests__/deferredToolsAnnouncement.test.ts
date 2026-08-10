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
