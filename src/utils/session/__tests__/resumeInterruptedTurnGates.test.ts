/**
 * The three gates on auto-continuing an interrupted turn.
 *
 * The consumer of `interrupted_prompt` re-enqueues it with no human in the
 * loop, so it runs tools and writes files immediately. Resuming a session that
 * was abandoned days ago therefore replays stale intent into a workspace that
 * has moved on — which is what the age gate exists to stop.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from 'src/types/message.js'
import { deserializeMessagesWithInterruptDetection } from '../conversationRecovery.js'

const MAX_AGE_ENV = 'CLAUDE_CODE_RESUME_INTERRUPTED_TURN_MAX_AGE_MS'
const PROMPT_ENV = 'CLAUDE_CODE_RESUME_PROMPT'

const originalMaxAge = process.env[MAX_AGE_ENV]
const originalPrompt = process.env[PROMPT_ENV]

beforeEach(() => {
  delete process.env[MAX_AGE_ENV]
  delete process.env[PROMPT_ENV]
})

afterEach(() => {
  if (originalMaxAge === undefined) delete process.env[MAX_AGE_ENV]
  else process.env[MAX_AGE_ENV] = originalMaxAge
  if (originalPrompt === undefined) delete process.env[PROMPT_ENV]
  else process.env[PROMPT_ENV] = originalPrompt
})

function uuid(n: number): UUID {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as UUID
}

const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

/**
 * Assistant tool_use followed by its tool_result, nothing after: the classic
 * "killed while running a tool" transcript, which detection reports as
 * interrupted_turn and which therefore gets a synthetic continuation.
 */
function interruptedToolTurn(ageMs: number): Message[] {
  const timestamp = isoAgo(ageMs)
  return [
    {
      type: 'user',
      uuid: uuid(1),
      timestamp,
      message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    },
    {
      type: 'assistant',
      uuid: uuid(2),
      timestamp,
      message: {
        id: 'msg_2',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool_1', name: 'Bash', input: {} }],
      },
    },
    {
      type: 'user',
      uuid: uuid(3),
      timestamp,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' },
        ],
      },
    },
  ] as unknown as Message[]
}

/** Transcript ending on a plain user prompt: interrupted before any response. */
function interruptedPromptTurn(ageMs: number): Message[] {
  return [
    {
      type: 'user',
      uuid: uuid(1),
      timestamp: isoAgo(ageMs),
      message: { role: 'user', content: [{ type: 'text', text: 'do it' }] },
    },
  ] as unknown as Message[]
}

function continuationTexts(messages: Message[]): string[] {
  return messages
    .filter(m => m.type === 'user' && (m as { isMeta?: boolean }).isMeta)
    .map(m => {
      const content = (m as { message?: { content?: unknown } }).message
        ?.content
      return typeof content === 'string'
        ? content
        : Array.isArray(content) &&
            (content[0] as { text?: string } | undefined)?.text
          ? ((content[0] as { text: string }).text as string)
          : ''
    })
}

describe('interrupted-turn staleness gate', () => {
  test('a turn interrupted minutes ago is still auto-continued', () => {
    const result = deserializeMessagesWithInterruptDetection(
      interruptedToolTurn(5 * MINUTE),
    )

    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
    expect(continuationTexts(result.messages)).toContain(
      'Continue from where you left off.',
    )
  })

  test('a turn interrupted days ago is suppressed', () => {
    const result = deserializeMessagesWithInterruptDetection(
      interruptedToolTurn(3 * DAY),
    )

    expect(result.turnInterruptionState.kind).toBe('none')
    // The synthetic prompt must not be left sitting in the transcript either —
    // the consumer re-enqueues whatever it finds.
    expect(continuationTexts(result.messages)).not.toContain(
      'Continue from where you left off.',
    )
  })

  test('the gate covers interrupted_prompt too, not just interrupted_turn', () => {
    const fresh = deserializeMessagesWithInterruptDetection(
      interruptedPromptTurn(5 * MINUTE),
    )
    expect(fresh.turnInterruptionState.kind).toBe('interrupted_prompt')

    const stale = deserializeMessagesWithInterruptDetection(
      interruptedPromptTurn(3 * DAY),
    )
    expect(stale.turnInterruptionState.kind).toBe('none')
  })

  test('0 disables the gate entirely', () => {
    process.env[MAX_AGE_ENV] = '0'

    const result = deserializeMessagesWithInterruptDetection(
      interruptedToolTurn(30 * DAY),
    )

    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  })

  test('an explicit window is honored on both sides of the boundary', () => {
    process.env[MAX_AGE_ENV] = String(10 * MINUTE)

    expect(
      deserializeMessagesWithInterruptDetection(interruptedToolTurn(5 * MINUTE))
        .turnInterruptionState.kind,
    ).toBe('interrupted_prompt')
    expect(
      deserializeMessagesWithInterruptDetection(
        interruptedToolTurn(20 * MINUTE),
      ).turnInterruptionState.kind,
    ).toBe('none')
  })

  test('a garbage window falls back to the default rather than disabling the gate', () => {
    process.env[MAX_AGE_ENV] = 'soon'

    expect(
      deserializeMessagesWithInterruptDetection(interruptedToolTurn(3 * DAY))
        .turnInterruptionState.kind,
    ).toBe('none')
    expect(
      deserializeMessagesWithInterruptDetection(interruptedToolTurn(5 * MINUTE))
        .turnInterruptionState.kind,
    ).toBe('interrupted_prompt')
  })

  test('a transcript with no usable timestamp is treated as stale', () => {
    const noTimestamps = interruptedToolTurn(5 * MINUTE).map(m => {
      const copy = { ...(m as object) } as Record<string, unknown>
      delete copy.timestamp
      return copy as unknown as Message
    })

    expect(
      deserializeMessagesWithInterruptDetection(noTimestamps)
        .turnInterruptionState.kind,
    ).toBe('none')
  })

  test('epoch-millisecond timestamps are understood', () => {
    const epochStamped = interruptedToolTurn(5 * MINUTE).map(m => ({
      ...(m as object),
      timestamp: Date.now() - 5 * MINUTE,
    })) as unknown as Message[]

    expect(
      deserializeMessagesWithInterruptDetection(epochStamped)
        .turnInterruptionState.kind,
    ).toBe('interrupted_prompt')
  })
})

describe('resume prompt override', () => {
  test('CLAUDE_CODE_RESUME_PROMPT replaces the default continuation', () => {
    process.env[PROMPT_ENV] = 'Pick up the migration where it stopped.'

    const result = deserializeMessagesWithInterruptDetection(
      interruptedToolTurn(5 * MINUTE),
    )

    expect(continuationTexts(result.messages)).toContain(
      'Pick up the migration where it stopped.',
    )
    expect(continuationTexts(result.messages)).not.toContain(
      'Continue from where you left off.',
    )
  })

  test('an empty override falls back to the default', () => {
    process.env[PROMPT_ENV] = ''

    const result = deserializeMessagesWithInterruptDetection(
      interruptedToolTurn(5 * MINUTE),
    )

    expect(continuationTexts(result.messages)).toContain(
      'Continue from where you left off.',
    )
  })
})

describe('resume anchor de-duplication', () => {
  test('re-offering the same tail is suppressed', () => {
    const messages = interruptedToolTurn(5 * MINUTE)

    const result = deserializeMessagesWithInterruptDetection(messages, {
      resumeAnchorUuid: uuid(3),
    })

    expect(result.turnInterruptionState.kind).toBe('none')
    expect(continuationTexts(result.messages)).not.toContain(
      'Continue from where you left off.',
    )
  })

  test('an anchor from an earlier tail does not suppress', () => {
    const messages = interruptedToolTurn(5 * MINUTE)

    const result = deserializeMessagesWithInterruptDetection(messages, {
      resumeAnchorUuid: uuid(1),
    })

    expect(result.turnInterruptionState.kind).toBe('interrupted_prompt')
  })
})
