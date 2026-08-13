import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { AskUserQuestionTool } = await import('../AskUserQuestionTool.js')

// The tool result must not read approval into a redirection. When the user
// selects "Other" and types custom text, the answer is NOT one of the offered
// labels, and the model must be told to read it literally rather than proceed.

type Question = {
  question: string
  header: string
  options: { label: string; description: string }[]
  multiSelect?: boolean
}

function result(
  questions: Question[],
  answers: Record<string, string>,
  annotations?: Record<string, { notes?: string; preview?: string }>,
): string {
  const block = AskUserQuestionTool.mapToolResultToToolResultBlockParam(
    { questions, answers, ...(annotations && { annotations }) } as never,
    'tool_use_1',
  )
  return block.content as string
}

const q: Question = {
  question: 'Which library should we use?',
  header: 'Library',
  options: [
    { label: 'date-fns', description: 'lightweight' },
    { label: 'luxon', description: 'full-featured' },
  ],
}

describe('AskUserQuestion mapToolResultToToolResultBlockParam', () => {
  test('offered-label answer tells the model it can proceed', () => {
    const text = result([q], { [q.question]: 'date-fns' })
    expect(text).toContain('Your questions have been answered')
    expect(text).toContain('You can now continue with these answers in mind')
  })

  test('custom "Other" text warns the model it may be a redirection or a stop', () => {
    const text = result([q], {
      [q.question]:
        "actually don't add a date library, remove the call site instead",
    })
    expect(text).toContain('The user answered:')
    expect(text).toContain(
      'they may request clarification, changes, or that you not proceed',
    )
    expect(text).toContain('follow what they actually say')
    // Must NOT read as approval.
    expect(text).not.toContain('You can now continue')
  })

  test('multi-select where every part is an offered label proceeds', () => {
    const multi: Question = { ...q, multiSelect: true }
    const text = result([multi], { [multi.question]: 'date-fns, luxon' })
    expect(text).toContain('You can now continue with these answers in mind')
  })

  test('multi-select containing a non-offered part warns', () => {
    const multi: Question = { ...q, multiSelect: true }
    const text = result([multi], {
      [multi.question]: 'date-fns, something-else',
    })
    expect(text).toContain('follow what they actually say')
  })

  test('freeform notes force the read-carefully branch', () => {
    const text = result(
      [q],
      { [q.question]: 'date-fns' },
      { [q.question]: { notes: 'but pin the version' } },
    )
    expect(text).toContain('follow what they actually say')
    expect(text).not.toContain('You can now continue')
  })

  test('no answers reports that the user did not answer', () => {
    const text = result([q], {})
    expect(text).toBe('The user did not answer the questions.')
  })
})
