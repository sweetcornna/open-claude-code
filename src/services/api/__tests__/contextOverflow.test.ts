import { describe, expect, test } from 'bun:test'
import type { AssistantMessage } from 'src/types/message.js'
import {
  classifyAPIError,
  isContextOverflowErrorText,
  isPromptTooLongMessage,
  parsePromptTooLongTokenCounts,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
} from '../errors.js'

/**
 * Regression guard for the "autocompact never fires on a third-party gateway"
 * outage: occ recognised only Anthropic's `Prompt is too long`, so an
 * OpenAI-compatible gateway's `context_length_exceeded` matched nothing and
 * both compaction fallbacks (reactive compact and the blocking-limit preempt)
 * stayed dark while the session grew to 371K tokens.
 *
 * The exact string below is copied verbatim from the user's transcript
 * (.occ/projects/<project>/9f529ecf-....jsonl, line 3678).
 */
const REAL_GATEWAY_ERROR_TEXT =
  'API Error [OpenAI]: Your input exceeds the context window of this model. Please adjust your input and try again. · code=context_length_exceeded · type=invalid_request_error · name=OpenAIRequestError · category=invalid_request · retryable=no'

const REAL_GATEWAY_ERROR_DETAILS = JSON.stringify({
  provider: 'OpenAI',
  code: 'context_length_exceeded',
  type: 'invalid_request_error',
  name: 'OpenAIRequestError',
  message:
    'Your input exceeds the context window of this model. Please adjust your input and try again.',
  category: 'invalid_request',
  retryable: false,
  replayable: true,
})

function apiErrorMessage(
  text: string,
  errorDetails?: string,
): AssistantMessage {
  return {
    type: 'assistant',
    isApiErrorMessage: true,
    ...(errorDetails === undefined ? {} : { errorDetails }),
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  } as unknown as AssistantMessage
}

describe('isContextOverflowErrorText', () => {
  test.each([
    ['Anthropic', 'prompt is too long: 137500 tokens > 135000 maximum'],
    ['Anthropic capitalized (Vertex)', 'Prompt is too long'],
    ['Bedrock', 'Input is too long for requested model.'],
    [
      'Anthropic max_tokens overflow',
      'input length and `max_tokens` exceed context limit: 200000 + 8192 > 204698',
    ],
    ['OpenAI gateway prose', REAL_GATEWAY_ERROR_TEXT],
    ['OpenAI error code', 'context_length_exceeded'],
    [
      'OpenAI classic',
      "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
    ],
    [
      'Gemini',
      'The input token count (1052916) exceeds the maximum number of tokens allowed (1048576).',
    ],
    ['Grok / xAI', 'Please reduce the length of the messages or completion.'],
    ['vLLM / local runtime', 'Requested tokens exceed context window of 32768'],
    ['generic', 'context window exceeded'],
    ['generic tokens', 'too many tokens in request'],
  ])('recognises %s wording', (_label, raw) => {
    expect(isContextOverflowErrorText(raw)).toBe(true)
  })

  test.each([
    ['rate limit', 'Rate limit reached. Please try again later.'],
    ['auth', 'Not logged in · Please run /login'],
    ['image size', 'image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes'],
    ['pdf', 'A maximum of 100 PDF pages is supported'],
    ['overload', '{"type":"overloaded_error"}'],
    ['network', 'getaddrinfo ENOTFOUND api.example.com'],
    ['max output', 'maximum output length exceeded'],
  ])('does not claim %s errors', (_label, raw) => {
    expect(isContextOverflowErrorText(raw)).toBe(false)
  })
})

describe('isPromptTooLongMessage', () => {
  test('still matches the exact Anthropic content, byte for byte', () => {
    expect(
      isPromptTooLongMessage(apiErrorMessage(PROMPT_TOO_LONG_ERROR_MESSAGE)),
    ).toBe(true)
  })

  test('matches the real third-party gateway error from the outage', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorMessage(REAL_GATEWAY_ERROR_TEXT, REAL_GATEWAY_ERROR_DETAILS),
      ),
    ).toBe(true)
  })

  test('matches on errorDetails alone when the rendered text is generic', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorMessage(
          'API Error [OpenAI]: request failed (400)',
          REAL_GATEWAY_ERROR_DETAILS,
        ),
      ),
    ).toBe(true)
  })

  test('ignores messages that are not API errors', () => {
    const msg = apiErrorMessage(REAL_GATEWAY_ERROR_TEXT)
    ;(msg as { isApiErrorMessage?: boolean }).isApiErrorMessage = false
    expect(isPromptTooLongMessage(msg)).toBe(false)
  })

  test('does not fire on unrelated API errors', () => {
    expect(
      isPromptTooLongMessage(
        apiErrorMessage(
          'API Error [OpenAI]: stream_read_error · code=stream_read_error · retryable=yes',
        ),
      ),
    ).toBe(false)
  })
})

describe('parsePromptTooLongTokenCounts', () => {
  test('parses the Anthropic form unchanged', () => {
    expect(
      parsePromptTooLongTokenCounts(
        'prompt is too long: 137500 tokens > 135000 maximum',
      ),
    ).toEqual({ actualTokens: 137500, limitTokens: 135000 })
  })

  test('parses the OpenAI form, where the limit is stated first', () => {
    expect(
      parsePromptTooLongTokenCounts(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 130512 tokens.",
      ),
    ).toEqual({ actualTokens: 130512, limitTokens: 128000 })
  })

  test('parses the Gemini form, where the actual count is stated first', () => {
    expect(
      parsePromptTooLongTokenCounts(
        'The input token count (1052916) exceeds the maximum number of tokens allowed (1048576).',
      ),
    ).toEqual({ actualTokens: 1052916, limitTokens: 1048576 })
  })

  test('degrades to undefined when no counts are quoted', () => {
    expect(parsePromptTooLongTokenCounts(REAL_GATEWAY_ERROR_TEXT)).toEqual({
      actualTokens: undefined,
      limitTokens: undefined,
    })
  })
})

/**
 * The widened matching must not reclassify anything on the Anthropic path.
 * These are the error strings the first-party API actually produces for
 * failures that are NOT context overflow; each has its own recovery path
 * (retry, /login, image strip, rewind) that a false prompt-too-long verdict
 * would hijack into a pointless compaction.
 */
describe('Anthropic path invariance', () => {
  test.each([
    'Your credit balance is too low to access the Claude API',
    'This request would exceed your organization’s rate limit',
    'Extra usage is required for long context',
    '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    '`tool_use` ids were found without `tool_result` blocks immediately after',
    '`tool_use` ids must be unique',
    'unexpected `tool_use_id` found in `tool_result`',
    'Invalid model name',
    'OAuth token has been revoked',
    'x-api-key header is required',
    'image exceeds 5 MB maximum: 5316852 bytes > 5242880 bytes',
    'image dimensions exceed the many-image limit',
    'The PDF specified is password protected',
    'The PDF specified was not valid',
    'maximum output length exceeded',
    'Request was aborted.',
  ])('leaves %s alone', raw => {
    expect(isContextOverflowErrorText(raw)).toBe(false)
    expect(
      isPromptTooLongMessage(apiErrorMessage(`API Error: 400 ${raw}`)),
    ).toBe(false)
  })
})

describe('classifyAPIError', () => {
  test('reports third-party context overflow as prompt_too_long', () => {
    expect(
      classifyAPIError(
        new Error(
          'Your input exceeds the context window of this model. Please adjust your input and try again.',
        ),
      ),
    ).toBe('prompt_too_long')
  })

  test('still reports the Anthropic wording as prompt_too_long', () => {
    expect(
      classifyAPIError(new Error('prompt is too long: 1 tokens > 0 maximum')),
    ).toBe('prompt_too_long')
  })
})
