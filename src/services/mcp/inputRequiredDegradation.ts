/**
 * Graceful degradation for an exhausted MCP multi-round input flow.
 *
 * The v2 client SDK auto-fulfils `input_required` results until the server
 * returns a complete tool result or `inputRequired.maxRounds` is exhausted.
 * Exhaustion is a local `SdkError`, not a tool result, even though its data
 * preserves the last request. Turning that typed error into text lets the
 * model see why the call stopped and which inputs the server still wanted.
 */

import { SdkError, SdkErrorCode } from '@modelcontextprotocol/client'

export type InputRequiredRoundsExceededDegradation = {
  content: string
  rounds: number | undefined
  inputRequestFields: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Builds a text result for the SDK's rounds-exceeded error, or returns
 * `undefined` so unrelated failures continue through the normal catch path.
 */
export function inputRequiredRoundsExceededDegradation(
  error: unknown,
  toolName: string,
): InputRequiredRoundsExceededDegradation | undefined {
  if (
    !(error instanceof SdkError) ||
    error.code !== SdkErrorCode.InputRequiredRoundsExceeded
  ) {
    return undefined
  }

  const data = isRecord(error.data) ? error.data : undefined
  const rounds =
    typeof data?.rounds === 'number' &&
    Number.isSafeInteger(data.rounds) &&
    data.rounds > 0
      ? data.rounds
      : undefined
  const lastResult = isRecord(data?.lastResult) ? data.lastResult : undefined
  const inputRequests = isRecord(lastResult?.inputRequests)
    ? lastResult.inputRequests
    : undefined
  const inputRequestFields = Object.keys(inputRequests ?? {})
  const roundLimit = rounds ?? 'the configured limit'

  return {
    content: `MCP tool "${toolName}" could not complete because the server needed more input rounds than allowed (${roundLimit}). Last requested input field names: ${JSON.stringify(inputRequestFields)}. Treat this call as incomplete; retry only if you can provide the remaining input or use another tool.`,
    rounds,
    inputRequestFields,
  }
}
