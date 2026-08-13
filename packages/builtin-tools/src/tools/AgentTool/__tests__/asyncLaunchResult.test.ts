import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { AgentTool } = await import('../AgentTool.js')

function textOf(data: unknown): string {
  const block = AgentTool.mapToolResultToToolResultBlockParam(
    data as never,
    'tool_use_1',
  )
  const content = block.content as { type: string; text: string }[]
  return content.map(c => c.text).join('\n')
}

describe('AgentTool async_launched tool result', () => {
  const base = {
    status: 'async_launched' as const,
    agentId: 'agent_abc',
    outputFile: '/tmp/agent_abc.jsonl',
  }

  test('forbids reading/tailing the JSONL transcript instead of inviting it', () => {
    const text = textOf({ ...base, canReadOutputFile: true })
    // The output_file is the full subagent JSONL transcript — reading it
    // overflows the parent context.
    expect(text).toContain('Do NOT Read or tail this file')
    expect(text).toContain('overflow your context')
    // The old, harmful guidance must be gone.
    expect(text).not.toContain('check progress before completion')
    expect(text).not.toMatch(/tail on the output file/)
  })

  test('SendMessage hint includes the required summary param', () => {
    const text = textOf({ ...base, canReadOutputFile: true })
    // SendMessage rejects a string message without a summary
    // ('summary is required when message is a string'), so the hint must show it.
    expect(text).toContain("summary: '<5-10 word recap>'")
  })
})

describe('AgentTool completed trailer', () => {
  test('SendMessage continuation hint includes the required summary param', () => {
    const text = textOf({
      status: 'completed',
      content: [{ type: 'text', text: 'all done' }],
      agentId: 'agent_xyz',
      totalTokens: 42,
      totalToolUseCount: 3,
      totalDurationMs: 1234,
    })
    expect(text).toContain("summary: '<5-10 word recap>'")
    expect(text).toContain("SendMessage with to: 'agent_xyz'")
  })
})
