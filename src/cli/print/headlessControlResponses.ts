/**
 * The two control_response shapes a headless session emits.
 *
 * Split into their own leaf module so every control-request handler — the
 * dispatcher, the MCP handlers, the OAuth handlers — can reply without
 * importing each other.
 */
import type { SDKControlRequest } from 'src/entrypoints/sdk/controlTypes.js'
import type { HeadlessRunState } from './headlessRunState.js'

export function sendControlResponseSuccess(
  state: HeadlessRunState,
  message: { request_id: string } | SDKControlRequest,
  response?: Record<string, unknown>,
): void {
  state.output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: message.request_id,
      response: response,
    },
  })
}

export function sendControlResponseError(
  state: HeadlessRunState,
  message: { request_id: string } | SDKControlRequest,
  errorMessage: string,
): void {
  state.output.enqueue({
    type: 'control_response',
    response: {
      subtype: 'error',
      request_id: message.request_id,
      error: errorMessage,
    },
  })
}
