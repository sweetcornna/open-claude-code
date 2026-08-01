import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'

mock.module('src/utils/log.ts', logMock)

const { inputRequiredRoundsExceededDegradation } = await import(
  '../inputRequiredDegradation.js'
)

describe('inputRequiredRoundsExceededDegradation', () => {
  test('builds a text result with the round limit and pending field names', () => {
    const error = new SdkError(
      SdkErrorCode.InputRequiredRoundsExceeded,
      "Multi-round-trip request 'tools/call' still required input after 10 rounds (inputRequired.maxRounds)",
      {
        rounds: 10,
        lastResult: {
          inputRequests: {
            accountId: { method: 'elicitation/create' },
            confirmation: { method: 'elicitation/create' },
          },
          requestState: 'opaque-state',
        },
      },
    )

    expect(
      inputRequiredRoundsExceededDegradation(error, 'lookup_customer'),
    ).toEqual({
      content:
        'MCP tool "lookup_customer" could not complete because the server needed more input rounds than allowed (10). Last requested input field names: ["accountId","confirmation"]. Treat this call as incomplete; retry only if you can provide the remaining input or use another tool.',
      rounds: 10,
      inputRequestFields: ['accountId', 'confirmation'],
    })
  })

  test('ignores errors that are not rounds-exceeded SDK errors', () => {
    expect(
      inputRequiredRoundsExceededDegradation(
        new SdkError(SdkErrorCode.RequestTimeout, 'request timed out'),
        'lookup_customer',
      ),
    ).toBeUndefined()
    expect(
      inputRequiredRoundsExceededDegradation(
        new Error('connection closed'),
        'lookup_customer',
      ),
    ).toBeUndefined()
  })
})
