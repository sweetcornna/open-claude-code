import { describe, expect, test } from 'bun:test'
import type { UUID } from 'crypto'
import type { Message } from 'src/types/message.js'
import {
  dedupeSessionStartHookMessages,
  deserializeMessages,
  dropMalformedAttachments,
  dropRetractedMessages,
  isWellFormedAttachmentPayload,
  validateResumeDropRange,
} from '../conversationRecovery.js'

function uuid(n: number): UUID {
  return `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000` as UUID
}

function user(
  n: number,
  content: unknown[],
  extra: Record<string, unknown> = {},
): Message {
  return {
    type: 'user',
    uuid: uuid(n),
    message: { role: 'user', content },
    ...extra,
  } as unknown as Message
}

function assistant(
  n: number,
  content: unknown[],
  messageMetadata: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Message {
  return {
    type: 'assistant',
    uuid: uuid(n),
    message: {
      id: `msg_${n}`,
      role: 'assistant',
      content,
      ...messageMetadata,
    },
    ...extra,
  } as unknown as Message
}

function attachment(
  n: number,
  payload: unknown,
  extra: Record<string, unknown> = {},
): Message {
  return {
    type: 'attachment',
    uuid: uuid(n),
    attachment: payload,
    ...extra,
  } as unknown as Message
}

describe('validateResumeDropRange', () => {
  const turnId = uuid(10)

  test('allows a local prompt and its internal turn output', () => {
    const result = validateResumeDropRange(
      [
        user(10, [{ type: 'text', text: 'do work' }]),
        assistant(11, [{ type: 'text', text: 'working' }]),
        attachment(12, { type: 'token_usage' }),
        user(13, [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' },
        ]),
      ],
      turnId,
    )

    expect(result).toEqual({ ok: true })
  })

  test('allows furniture before the declared turn prompt', () => {
    expect(
      validateResumeDropRange(
        [
          attachment(1, { type: 'date_change' }),
          user(10, [{ type: 'text', text: 'do work' }]),
        ],
        turnId,
      ),
    ).toEqual({ ok: true })
  })

  test('rejects queued content absorbed into the turn', () => {
    const result = validateResumeDropRange(
      [
        user(10, [{ type: 'text', text: 'do work' }]),
        attachment(11, { type: 'queued_command', prompt: 'next task' }),
      ],
      turnId,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('absorbed queued content'),
    })
  })

  test('rejects a compaction summary in the discarded range', () => {
    const result = validateResumeDropRange(
      [
        user(10, [{ type: 'text', text: 'do work' }]),
        user(11, [{ type: 'text', text: 'summary' }], {
          isCompactSummary: true,
        }),
      ],
      turnId,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('compaction summary'),
    })
  })

  test('rejects another ordinary user prompt', () => {
    const result = validateResumeDropRange(
      [
        user(10, [{ type: 'text', text: 'do work' }]),
        user(11, [{ type: 'text', text: 'do something else' }]),
      ],
      turnId,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not attributable'),
    })
  })

  test('rejects an externally sourced declared prompt', () => {
    const result = validateResumeDropRange(
      [
        user(10, [{ type: 'text', text: 'remote' }], {
          origin: { kind: 'channel', server: 'external' },
        }),
      ],
      turnId,
    )

    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining('externally-sourced'),
    })
  })

  test('rejects unknown entry types and invalid turn ids', () => {
    expect(
      validateResumeDropRange(
        [
          user(10, [{ type: 'text', text: 'do work' }]),
          { type: 'future-entry', uuid: uuid(11) } as unknown as Message,
        ],
        turnId,
      ),
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unrecognized entry'),
    })
    expect(validateResumeDropRange([], 'not-a-uuid')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not a UUID'),
    })
  })
})

function sessionStartContext(n: number, content: string[]): Message {
  return attachment(n, {
    type: 'hook_additional_context',
    content,
    hookName: 'SessionStart',
    toolUseID: 'SessionStart',
    hookEvent: 'SessionStart',
  })
}

function sessionStartSuccess(n: number, content: string): Message {
  return attachment(n, {
    type: 'hook_success',
    content,
    hookName: 'startup',
    toolUseID: 'SessionStart',
    hookEvent: 'SessionStart',
  })
}

describe('dropRetractedMessages', () => {
  test('drops retracted fallback messages by derived UUID prefix and keeps system markers', () => {
    const root = uuid(1)
    const derived = `${root.slice(0, 24)}ffffffffffff` as UUID
    const marker = {
      type: 'system',
      subtype: 'model_refusal_fallback',
      uuid: uuid(3),
      retractedMessageUuids: [root],
    } as unknown as Message
    const messages = [
      user(0, [{ type: 'text', text: 'root' }]),
      assistant(1, [{ type: 'text', text: 'retracted' }]),
      { ...user(2, [{ type: 'text', text: 'derived' }]), uuid: derived },
      marker,
      assistant(4, [{ type: 'text', text: 'fallback' }]),
    ]

    expect(dropRetractedMessages(messages)).toEqual([
      messages[0],
      marker,
      messages[4],
    ])
  })

  test('returns the original array when there are no retractions', () => {
    const messages = [user(0, [{ type: 'text', text: 'root' }])]
    expect(dropRetractedMessages(messages)).toBe(messages)
  })
})

describe('malformed attachment recovery', () => {
  test.each([
    ['missing payload', undefined],
    ['null payload', null],
    ['array payload', []],
    ['missing type', { content: 'x' }],
    ['non-string type', { type: 42 }],
    ['invoked_skills without an array', { type: 'invoked_skills' }],
    [
      'invoked_skills with a primitive entry',
      { type: 'invoked_skills', skills: ['bad'] },
    ],
    ['hook_success without string content', { type: 'hook_success' }],
    [
      'skill_listing without string content',
      { type: 'skill_listing', content: 42 },
    ],
    [
      'hook context without an array',
      { type: 'hook_additional_context', content: 'bad' },
    ],
    [
      'hook context with a non-string item',
      { type: 'hook_additional_context', content: ['ok', 42] },
    ],
  ])('rejects %s', (_name, payload) => {
    expect(isWellFormedAttachmentPayload(payload)).toBe(false)
  })

  test.each([
    { type: 'invoked_skills', skills: [{}] },
    { type: 'hook_success', content: '' },
    { type: 'skill_listing', content: '', names: ['legacy'] },
    { type: 'hook_additional_context', content: [] },
    { type: 'deferred_tools_delta', addedNames: [], futureField: true },
    { type: 'future_attachment', provider: 'opencode', metadata: { v: 1 } },
  ])('accepts a valid or unknown attachment payload: %j', payload => {
    expect(isWellFormedAttachmentPayload(payload)).toBe(true)
  })

  test('drops only malformed attachments and keeps unknown legal attachments byte-for-byte', () => {
    const unknown = attachment(2, {
      type: 'future_attachment',
      provider: 'opencode',
      metadata: { deepseek: true },
    })
    const messages = [
      user(0, [{ type: 'text', text: 'hello' }]),
      attachment(1, null),
      unknown,
      attachment(3, { type: 'hook_success', content: 42 }),
    ]

    const result = dropMalformedAttachments(messages)
    expect(result).toEqual([messages[0], unknown])
    expect(result[1]).toBe(unknown)
  })
})

describe('SessionStart hook deduplication', () => {
  test('dedupes success, non-blocking errors, and individual context items', () => {
    const existingError = attachment(2, {
      type: 'hook_non_blocking_error',
      command: 'check',
      exitCode: 1,
      stderr: 'failed',
      stdout: '',
      hookName: 'startup',
      toolUseID: 'SessionStart',
      hookEvent: 'SessionStart',
    })
    const freshError = attachment(7, {
      ...(existingError.attachment as Record<string, unknown>),
    })
    const existing = [
      sessionStartSuccess(1, 'same'),
      existingError,
      sessionStartContext(3, ['old context']),
    ]
    const unrelated = attachment(6, {
      type: 'hook_success',
      content: 'same',
      hookName: 'other',
      toolUseID: 'toolu_1',
      hookEvent: 'PreToolUse',
    })
    const hookMessages = [
      sessionStartSuccess(4, 'same'),
      sessionStartContext(5, ['old context', 'new context']),
      unrelated,
      freshError,
    ]

    expect(dedupeSessionStartHookMessages(existing, hookMessages)).toEqual([
      sessionStartContext(5, ['new context']),
      unrelated,
    ])
  })

  test('normalizes persisted-output paths before comparing hook content', () => {
    const before =
      '<persisted-output>\nFull output saved to: /old/session/result.txt\n</persisted-output>'
    const after =
      '<persisted-output>\nFull output saved to: /new/session/result.txt\n</persisted-output>'

    expect(
      dedupeSessionStartHookMessages(
        [sessionStartSuccess(1, before)],
        [sessionStartSuccess(2, after)],
      ),
    ).toEqual([])
  })

  test('is idempotent when the first filtered result is restored again', () => {
    const existing = [sessionStartContext(1, ['old'])]
    const fresh = [sessionStartContext(2, ['old', 'new'])]
    const first = dedupeSessionStartHookMessages(existing, fresh)

    expect(first).toEqual([sessionStartContext(2, ['new'])])
    expect(
      dedupeSessionStartHookMessages([...existing, ...first], fresh),
    ).toEqual([])
  })
})

describe('deserializeMessages recovery pipeline', () => {
  test('repairs a mixed transcript while preserving order, index 0, sidechain data, and provider metadata', () => {
    const root = user(0, [{ type: 'text', text: 'start' }], {
      isSidechain: false,
      agentId: 'main-agent',
    })
    const malformedOnly = assistant(1, [{ type: 'text', text: null }])
    const deferred = attachment(
      2,
      {
        type: 'deferred_tools_delta',
        addedNames: ['mcp__server__tool'],
        addedLines: ['tool line'],
        removedNames: [],
      },
      { isSidechain: true, agentId: 'agent-1' },
    )
    const providerMetadata = {
      model: 'deepseek-reasoner',
      reasoning_content: 'deep thoughts',
      _openaiReasoningItems: [
        { id: 'rs_1', encrypted_content: 'encrypted', summary: [] },
      ],
      opencode: { inferencePlane: 'console', orgId: 'org_1' },
    }
    const repaired = assistant(
      3,
      [
        { type: 'text', text: 42 },
        { type: 'text', text: 'answer', citations: [] },
      ],
      providerMetadata,
      { isSidechain: true, agentId: 'agent-1' },
    )
    const malformedAttachment = attachment(4, {
      type: 'hook_additional_context',
      content: [null],
    })
    const retracted = assistant(5, [{ type: 'text', text: 'withdrawn' }])
    const marker = {
      type: 'system',
      subtype: 'model_refusal_fallback',
      uuid: uuid(6),
      retractedMessageUuids: [retracted.uuid],
    } as unknown as Message
    const fallback = assistant(7, [{ type: 'text', text: 'fallback answer' }])

    const result = deserializeMessages([
      root,
      malformedOnly,
      deferred,
      repaired,
      malformedAttachment,
      retracted,
      marker,
      fallback,
    ])

    expect(result.map(message => message.uuid)).toEqual([
      root.uuid,
      deferred.uuid,
      repaired.uuid,
      marker.uuid,
      fallback.uuid,
    ])
    expect(result[0]).toBe(root)
    expect(result[1]).toBe(deferred)
    expect(result[1]).toMatchObject({ isSidechain: true, agentId: 'agent-1' })
    expect(result[2]).toMatchObject({
      isSidechain: true,
      agentId: 'agent-1',
      message: providerMetadata,
    })
    expect(result[2]!.message!.content).toEqual([
      { type: 'text', text: 'answer', citations: [] },
    ])
  })

  test('a clean completed transcript is unchanged across repeated recovery', () => {
    const messages = [
      user(0, [{ type: 'text', text: 'question' }]),
      attachment(2, {
        type: 'future_attachment',
        provider: 'opencode',
      }),
      assistant(1, [{ type: 'text', text: 'answer' }], {
        model: 'deepseek-chat',
        reasoning_content: 'reasoning',
      }),
    ]

    const first = deserializeMessages(messages)
    const second = deserializeMessages(first)

    expect(first).toEqual(messages)
    expect(second).toEqual(first)
    expect(first.map(message => message.uuid)).toEqual(
      messages.map(message => message.uuid),
    )
  })
})
