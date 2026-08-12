/**
 * The two system-reminders that carry deferred-tool information.
 *
 * `deferred_tools_delta` replaced a message that claude.ts re-appended to every
 * single request, so it is now the model's ONLY notice that deferred tools
 * exist. If its text drops the two-step instruction, the model gets a list of
 * names it has no idea how to invoke.
 *
 * `tool_search_usage_reminder` is the counter-pressure to the failure that
 * deferral creates: a model that never searches concludes the capability is
 * absent and hand-rolls a Bash workaround instead.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../tests/mocks/debug'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { normalizeAttachmentForAPI } = await import(
  '../../messages/attachmentNormalize.js'
)
const { getToolSearchUsageReminderAttachment } = await import('../deltas.js')

const REMINDER_ENV = 'CLAUDE_CODE_TOOL_SEARCH_REMINDER'
const originalReminderEnv = process.env[REMINDER_ENV]

afterEach(() => {
  if (originalReminderEnv === undefined) delete process.env[REMINDER_ENV]
  else process.env[REMINDER_ENV] = originalReminderEnv
})

function renderedText(attachment: unknown): string {
  const messages = normalizeAttachmentForAPI(attachment as never)
  return messages
    .map(m => (typeof m.message.content === 'string' ? m.message.content : ''))
    .join('\n')
}

describe('deferred_tools_delta rendering', () => {
  test('names the tools and spells out both steps', () => {
    const text = renderedText({
      type: 'deferred_tools_delta',
      addedNames: ['CronCreate', 'mcp__slack__send'],
      addedLines: ['CronCreate', 'mcp__slack__send'],
      removedNames: [],
    })

    expect(text).toContain('CronCreate')
    expect(text).toContain('mcp__slack__send')
    // Without these the announcement is a list of unusable names.
    expect(text).toContain('SearchExtraTools')
    expect(text).toContain('ExecuteExtraTool')
    expect(text).toContain('select:<tool_name>')
    // The names arrive without schemas; the model must be told so.
    expect(text).toContain('schemas are NOT loaded')
  })

  test('tells the model how to reach the tools the cap left out', () => {
    const text = renderedText({
      type: 'deferred_tools_delta',
      addedNames: ['A', 'B', 'C', 'D'],
      addedLines: ['A', 'B'],
      removedNames: [],
    })

    expect(text).toContain('…and 2 more')
    expect(text).toContain('keyword')
  })

  test('no overflow note when nothing was left out', () => {
    const text = renderedText({
      type: 'deferred_tools_delta',
      addedNames: ['A'],
      addedLines: ['A'],
      removedNames: [],
    })

    expect(text).not.toContain('and 0 more')
  })

  test('removals tell the model not to keep searching', () => {
    const text = renderedText({
      type: 'deferred_tools_delta',
      addedNames: [],
      addedLines: [],
      removedNames: ['mcp__slack__send'],
    })

    expect(text).toContain('no longer available')
    expect(text).toContain('mcp__slack__send')
  })
})

describe('tool_search_usage_reminder rendering', () => {
  test('lists the sample, counts the rest, and stays a suggestion', () => {
    const text = renderedText({
      type: 'tool_search_usage_reminder',
      undiscoveredToolNames: ['CronCreate', 'mcp__slack__send'],
      undiscoveredCount: 7,
    })

    expect(text).toContain('CronCreate, mcp__slack__send')
    expect(text).toContain('(+5 more)')
    expect(text).toContain('Before concluding a capability is missing')
    expect(text).toContain('SearchExtraTools')
    // It must not read as an instruction to go searching right now.
    expect(text).toContain('gentle reminder')
  })

  test('omits the overflow count when the whole set is listed', () => {
    const text = renderedText({
      type: 'tool_search_usage_reminder',
      undiscoveredToolNames: ['CronCreate'],
      undiscoveredCount: 1,
    })

    expect(text).not.toContain('more)')
  })
})

const GATEWAY_TOOLS = [
  { name: 'SearchExtraTools' },
  { name: 'ExecuteExtraTool' },
]

function makeContext(extraTools: { name: string }[] = []): never {
  return {
    options: { tools: [...GATEWAY_TOOLS, ...extraTools] },
  } as never
}

function assistantTurns(count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({
    type: 'assistant',
    uuid: `a${i}`,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  }))
}

describe('tool_search_usage_reminder triggering', () => {
  test('stays quiet early in a conversation', () => {
    const attachments = getToolSearchUsageReminderAttachment(
      makeContext([{ name: 'CronCreate' }]),
      assistantTurns(5) as never,
    )
    expect(attachments).toEqual([])
  })

  test('fires after a long stretch with no search', () => {
    const attachments = getToolSearchUsageReminderAttachment(
      makeContext([{ name: 'CronCreate' }]),
      assistantTurns(20) as never,
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'tool_search_usage_reminder',
      undiscoveredToolNames: ['CronCreate'],
      undiscoveredCount: 1,
    })
  })

  test('a recent SearchExtraTools call resets the clock', () => {
    const messages = [
      ...assistantTurns(20),
      {
        type: 'assistant',
        uuid: 'searched',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'SearchExtraTools', input: {} },
          ],
        },
      },
      ...assistantTurns(3),
    ]
    expect(
      getToolSearchUsageReminderAttachment(
        makeContext([{ name: 'CronCreate' }]),
        messages as never,
      ),
    ).toEqual([])
  })

  test('does not repeat itself on the very next turn', () => {
    const messages = [
      ...assistantTurns(20),
      {
        type: 'attachment',
        uuid: 'r1',
        attachment: {
          type: 'tool_search_usage_reminder',
          undiscoveredToolNames: ['CronCreate'],
          undiscoveredCount: 1,
        },
      },
      ...assistantTurns(2),
    ]
    expect(
      getToolSearchUsageReminderAttachment(
        makeContext([{ name: 'CronCreate' }]),
        messages as never,
      ),
    ).toEqual([])
  })

  test('silent when every deferred tool has already been searched', () => {
    const messages = [
      {
        type: 'user',
        uuid: 'u1',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'x',
              content: 'Found 1 deferred tool(s): CronCreate.',
            },
          ],
        },
      },
      ...assistantTurns(20),
    ]
    expect(
      getToolSearchUsageReminderAttachment(
        makeContext([{ name: 'CronCreate' }]),
        messages as never,
      ),
    ).toEqual([])
  })

  test('silent when nothing is deferred at all', () => {
    expect(
      getToolSearchUsageReminderAttachment(
        makeContext(),
        assistantTurns(20) as never,
      ),
    ).toEqual([])
  })

  test('silent when the deferred gateway is unavailable', () => {
    const contextWithoutExecute = {
      options: {
        tools: [{ name: 'SearchExtraTools' }, { name: 'CronCreate' }],
      },
    } as never
    expect(
      getToolSearchUsageReminderAttachment(
        contextWithoutExecute,
        assistantTurns(20) as never,
      ),
    ).toEqual([])
  })

  test('the env escape hatch silences it', () => {
    process.env[REMINDER_ENV] = '0'
    expect(
      getToolSearchUsageReminderAttachment(
        makeContext([{ name: 'CronCreate' }]),
        assistantTurns(20) as never,
      ),
    ).toEqual([])
  })
})
