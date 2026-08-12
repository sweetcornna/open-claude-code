import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  normalizeOpenAIUsage,
  readReasoningItems,
  type AnthropicUsage,
  type OpenAIReasoningItem,
} from '@ant/model-provider'
import {
  getValidChatGPTAuth,
  getValidChatGPTAuthForSearch,
} from './chatgptAuth.js'
import type {
  ResponsesReasoningEffort,
  ResponsesReasoningSummary,
} from './reasoning.js'
import {
  getResponsesReasoningSummary,
  isResponsesReasoningSummaryDisabled,
} from './reasoning.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import { buildProviderResourceURL } from 'src/utils/network/providerUrl.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  getAPIErrorDiagnostics,
  isRetryableAPIError,
  NonRetryableError,
} from '../retryClassification.js'
import {
  createOpenAIResponseError,
  OpenAIRequestError,
  parseRetryAfterFromErrorPayload,
  retryOpenAIRequest,
} from './retry.js'

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = Record<string, unknown>

/** `include` value that makes reasoning items replayable under `store: false`. */
export const REASONING_ENCRYPTED_CONTENT_INCLUDE = 'reasoning.encrypted_content'
type ResponsesRequest = {
  model: string
  stream: true
  store: false
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: {
    effort: ResponsesReasoningEffort
    /**
     * Opt-in for reasoning summaries. Omitted entirely, the stream carries no
     * reasoning text — which is what made GPT turns look idle while the model
     * was thinking. See getResponsesReasoningSummary.
     */
    summary?: ResponsesReasoningSummary
  }
  text?: { verbosity: 'low' | 'medium' | 'high' }
  /**
   * Opt-in response fields. `reasoning.encrypted_content` is what makes the
   * reasoning items replayable under `store: false`: without asking for it
   * the server returns reasoning items with no payload, so there is nothing
   * to carry the chain of thought into the next turn.
   */
  include?: string[]
  parallel_tool_calls?: boolean
  /**
   * Generic `/responses` endpoints only. The ChatGPT Codex backend rejects
   * this parameter, so its route never sets it.
   */
  max_output_tokens?: number
  /** Sticky cache routing key — stable for the occ session. */
  prompt_cache_key?: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function convertUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textFromContent(content)
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      result.push({ type: 'input_text', text: record.text })
    } else if (record.type === 'image_url') {
      const imageUrl = record.image_url as Record<string, unknown> | undefined
      if (typeof imageUrl?.url === 'string') {
        result.push({ type: 'input_image', image_url: imageUrl.url })
      }
    }
  }
  return result.length > 0 ? result : textFromContent(content)
}

function convertMessagesToResponsesInput(messages: unknown[]): {
  input: ResponsesInputItem[]
  instructions?: string
} {
  const input: ResponsesInputItem[] = []
  const instructions: string[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const role = record.role

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(record.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = record.tool_call_id
      if (typeof callId === 'string') {
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: textFromContent(record.content),
        })
      }
      continue
    }

    if (role === 'assistant') {
      // Reasoning items lead the turn — the order the Responses API emitted
      // them in. Replaying them is what carries the model's chain of thought
      // across turns under `store: false`; see OPENAI_REASONING_ITEMS_FIELD
      // for why this is a fidelity fix rather than a cache fix.
      for (const item of readReasoningItems(record)) {
        input.push({
          type: 'reasoning',
          ...(item.id !== undefined ? { id: item.id } : {}),
          ...(item.encrypted_content !== undefined
            ? { encrypted_content: item.encrypted_content }
            : {}),
          summary: Array.isArray(item.summary) ? item.summary : [],
        })
      }
      const text = textFromContent(record.content)
      if (text) {
        // Replayed as an `output_text` message item — the exact shape the API
        // emitted it in. The bare `{role, content: string}` form is accepted
        // too but normalizes to `input_text`, i.e. it tells the model its own
        // previous answer was user input.
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        })
      }
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const tc = toolCall as Record<string, unknown>
          const fn = tc.function as Record<string, unknown> | undefined
          const id = typeof tc.id === 'string' ? tc.id : undefined
          const name = typeof fn?.name === 'string' ? fn.name : undefined
          if (!id || !name) continue
          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          })
        }
      }
      continue
    }

    if (role === 'user') {
      input.push({
        role: 'user',
        content: convertUserContent(record.content),
      })
    }
  }

  return {
    input,
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
  }
}

function convertToolsToResponses(tools: unknown[]): ResponsesTool[] {
  const result: ResponsesTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) {
      // Server-side built-in tools (`{ type: 'web_search' }`, …) carry no
      // function descriptor: the Responses API takes them verbatim. Pass them
      // through instead of dropping them — WebSearch's `codex` adapter asks
      // for the built-in web_search tool this way, and it must not have to
      // hand-roll a request body around this converter.
      if (typeof record.type === 'string' && record.type !== 'function') {
        result.push({ ...record })
      }
      continue
    }
    result.push({
      type: 'function',
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      strict: false,
    })
  }
  return result
}

function convertToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'required') return 'required'
  if (toolChoice === 'auto') return 'auto'
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  const record = toolChoice as Record<string, unknown>
  const fn = record.function as Record<string, unknown> | undefined
  if (record.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'function', name: fn.name }
  }
  return toolChoice
}

export function buildResponsesRequest(params: {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  verbosity?: 'low' | 'medium' | 'high'
  /**
   * ChatGPT OAuth route: always set (session-scoped). Generic route: set only
   * for OpenAI's official endpoint — compatible providers must not receive
   * OpenAI-specific request parameters.
   */
  promptCacheKey?: string
  /** Generic `/responses` endpoints only — the ChatGPT backend rejects it. */
  maxOutputTokens?: number
  /**
   * Reasoning-summary detail, or `'off'` to skip the opt-in. Defaults to the
   * user's `OPENAI_REASONING_SUMMARY` setting. Internal side queries pass
   * `'off'`: nothing renders their thinking, and the summary would eat into an
   * output budget that reasoning tokens already strain.
   */
  reasoningSummary?: ResponsesReasoningSummary | 'off'
}): ResponsesRequest {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
  const reasoningSummary =
    params.reasoningSummary === 'off'
      ? undefined
      : (params.reasoningSummary ??
        (reasoningSummarySupported() && !isResponsesReasoningSummaryDisabled()
          ? getResponsesReasoningSummary()
          : undefined))
  return {
    model: params.model,
    stream: true,
    store: false,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(params.toolChoice
      ? { tool_choice: convertToolChoiceToResponses(params.toolChoice) }
      : {}),
    ...(params.reasoningEffort
      ? {
          reasoning: {
            effort: params.reasoningEffort,
            // Asking for a summary is the only way the stream carries any
            // reasoning text; a request without it reports nothing while the
            // model thinks. Suppressed once an endpoint has rejected the
            // field (unverified org, strict gateway) — see fetchResponsesStream.
            ...(reasoningSummary ? { summary: reasoningSummary } : {}),
          },
          include: [REASONING_ENCRYPTED_CONTENT_INCLUDE],
        }
      : {}),
    ...(params.verbosity ? { text: { verbosity: params.verbosity } } : {}),
    parallel_tool_calls: true,
    ...(params.maxOutputTokens !== undefined
      ? { max_output_tokens: params.maxOutputTokens }
      : {}),
    // Same session → same key so OpenAI can sticky-route to a cache node.
    // Must not hash the full message list (would change every turn).
    ...(params.promptCacheKey !== undefined
      ? { prompt_cache_key: params.promptCacheKey }
      : {}),
  }
}

/**
 * What an attempt has already put beyond recall. The two committing kinds are
 * separated because only one of them is unsafe to replay for *every* consumer:
 *
 *  - `side_effect` — a `function_call` item was announced, its arguments
 *    started streaming, or the response reached a terminal event. Replaying
 *    could surface the same tool call twice, so it ends the retry window no
 *    matter who is reading.
 *  - `text` — assistant text, a refusal, or reasoning text. Whether replaying
 *    is safe depends entirely on what the reader did with it, which is why the
 *    reader has to say so (see `discardsPartialOutput`).
 */
type ResponseCommitment = 'none' | 'text' | 'side_effect'

const COMMITTING_TEXT_DELTAS = new Set([
  'response.output_text.delta',
  'response.refusal.delta',
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
])

function responseCommitment(
  event: Record<string, unknown>,
): ResponseCommitment {
  if (
    event.type === 'response.completed' ||
    event.type === 'response.incomplete'
  ) {
    return 'side_effect'
  }
  if (
    event.type === 'response.output_item.added' ||
    // `.done` and not just `.added`: an endpoint that announces a completed
    // function call in one event (see the `.done` fallback in
    // adaptResponsesStreamToAnthropic) has still put a tool call beyond recall,
    // and monotonicity makes this a no-op on streams that sent `.added` first.
    event.type === 'response.output_item.done'
  ) {
    const item = event.item as Record<string, unknown> | undefined
    return item?.type === 'function_call' ? 'side_effect' : 'none'
  }
  if (
    typeof event.type !== 'string' ||
    String(event.delta ?? '').length === 0
  ) {
    return 'none'
  }
  if (event.type === 'response.function_call_arguments.delta') {
    return 'side_effect'
  }
  return COMMITTING_TEXT_DELTAS.has(event.type) ? 'text' : 'none'
}

/** Monotonic: no amount of following text takes a side effect back. */
function raiseCommitment(
  current: ResponseCommitment,
  event: Record<string, unknown>,
): ResponseCommitment {
  if (current === 'side_effect') return current
  const next = responseCommitment(event)
  return next === 'none' ? current : next
}

/**
 * Has this attempt lost the right to be replayed?
 *
 * `discardsPartialOutput` is the reader's promise that it buffers the whole
 * response and throws partial output away — true for `sideQuery` and the
 * WebSearch codex adapter, false for the main loop, whose deltas go straight
 * to the terminal, to ACP `agent_message_chunk` notifications and to
 * `--include-partial-messages` stdout. Those three are append-only: there is
 * no protocol for un-saying a chunk, so replaying after text double-renders.
 *
 * This predicate is deliberately the *same* one that moves the handoff barrier
 * in `fetchResponsesStream`'s `attempt`. Keeping them in lockstep is what makes
 * exactly-once delivery structural rather than incidental: an event is either
 * still inside the buffer a retry will discard, or it is out and the failure is
 * permanent — never both.
 */
function closesRetryWindow(
  commitment: ResponseCommitment,
  discardsPartialOutput: boolean,
): boolean {
  return (
    commitment === 'side_effect' ||
    (commitment === 'text' && !discardsPartialOutput)
  )
}

function eventErrorPayload(
  event: Record<string, unknown>,
  sseEvent: string | undefined,
): Record<string, unknown> | undefined {
  const response =
    event.response && typeof event.response === 'object'
      ? (event.response as Record<string, unknown>)
      : undefined
  const data =
    event.data && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>)
      : undefined
  const nested = [event.error, response?.error, data?.error].find(
    value => typeof value === 'object' && value !== null,
  ) as Record<string, unknown> | undefined
  const isErrorEvent =
    sseEvent === 'error' ||
    event.type === 'error' ||
    event.type === 'response.error' ||
    event.type === 'response.failed'
  return nested ?? (isErrorEvent ? event : undefined)
}

function streamEventError(
  event: Record<string, unknown>,
  sseEvent: string | undefined,
  label: string,
  retryWindowClosed: boolean,
): OpenAIRequestError | undefined {
  const error = eventErrorPayload(event, sseEvent)
  if (!error) return undefined
  const message =
    typeof error.message === 'string'
      ? error.message
      : `${label} stream returned an error event`
  const scalar = (value: unknown): string | number | undefined =>
    typeof value === 'string' || typeof value === 'number' ? value : undefined
  // No headers exist on an SSE frame, so a rate limit can only state its wait
  // in prose. See parseRetryAfterFromErrorPayload.
  const retryAfterMs = parseRetryAfterFromErrorPayload(error)
  return new OpenAIRequestError(`${label} stream failed: ${message}`, {
    retryable: !retryWindowClosed && isRetryableAPIError(error),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(typeof error.type === 'string' ? { type: error.type } : {}),
    ...(scalar(error.code) !== undefined ? { code: scalar(error.code) } : {}),
    ...(scalar(error.status) !== undefined
      ? { status: scalar(error.status) }
      : {}),
    cause: error,
  })
}

async function* parseSSE(
  response: Response,
  options: {
    signal: AbortSignal
    abort: (reason: Error) => void
    idleTimeoutMs: number
    label: string
    /** See {@link closesRetryWindow}. */
    discardsPartialOutput: boolean
  },
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body)
    throw new OpenAIRequestError(
      `${options.label} stream did not include a body`,
      { retryable: true },
    )
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let scanIndex = 0
  let commitment: ResponseCommitment = 'none'
  let hasTerminalEvent = false
  const retryWindowClosed = () =>
    closesRetryWindow(commitment, options.discardsPartialOutput)

  const parseFrame = (frame: string): Record<string, unknown> | undefined => {
    const lines = frame.split(/\r?\n/)
    const data = lines
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    const sseEvent = lines
      .find(line => line.startsWith('event:'))
      ?.slice(6)
      .trimStart()
    if (!data) return undefined
    if (data === '[DONE]') {
      hasTerminalEvent = true
      return undefined
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch (cause) {
      throw new OpenAIRequestError(
        `${options.label} stream returned invalid SSE JSON`,
        { retryable: !retryWindowClosed(), cause },
      )
    }
    if (!parsed || typeof parsed !== 'object') return undefined
    const event = parsed as Record<string, unknown>
    if (
      event.type === 'response.completed' ||
      event.type === 'response.incomplete'
    ) {
      hasTerminalEvent = true
    }
    const error = streamEventError(
      event,
      sseEvent,
      options.label,
      retryWindowClosed(),
    )
    if (error) throw error
    return event
  }

  const takeFrame = (): string | undefined => {
    for (let i = scanIndex; i < buffer.length - 1; i++) {
      const isLFBoundary = buffer[i] === '\n' && buffer[i + 1] === '\n'
      const isCRLFBoundary =
        buffer[i] === '\r' && buffer.slice(i, i + 4) === '\r\n\r\n'
      if (!isLFBoundary && !isCRLFBoundary) continue
      const boundaryLength = isCRLFBoundary ? 4 : 2
      const frame = buffer.slice(0, i)
      buffer = buffer.slice(i + boundaryLength)
      scanIndex = 0
      return frame
    }
    scanIndex = Math.max(0, buffer.length - 3)
    return undefined
  }

  type ReadResult = Awaited<ReturnType<typeof reader.read>>
  const read = (): Promise<ReadResult> =>
    new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', onAbort)
      }
      const resolveOnce = (value: ReadResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(value)
      }
      const rejectOnce = (error: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const onAbort = () =>
        rejectOnce(
          options.signal.reason instanceof Error
            ? options.signal.reason
            : new DOMException('The operation was aborted', 'AbortError'),
        )
      const timer = setTimeout(() => {
        const error = new OpenAIRequestError(
          `${options.label} stream idle timeout after ${options.idleTimeoutMs}ms`,
          { retryable: !retryWindowClosed() },
        )
        rejectOnce(error)
        options.abort(error)
        void reader.cancel(error).catch(() => {})
      }, options.idleTimeoutMs)
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) {
        onAbort()
        return
      }
      void reader.read().then(resolveOnce, rejectOnce)
    })

  try {
    while (true) {
      let result: ReadResult
      try {
        result = await read()
      } catch (cause) {
        // A transport failure this late is still transient, but replaying it
        // would re-produce output the reader can no longer un-see. Pin it
        // permanent so no ladder above tries. See closesRetryWindow.
        if (retryWindowClosed() && isRetryableAPIError(cause)) {
          throw new OpenAIRequestError(
            cause instanceof Error
              ? cause.message
              : `${options.label} stream failed`,
            { retryable: false, cause },
          )
        }
        throw cause
      }
      const { done, value } = result
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let frame = takeFrame()
      while (frame !== undefined) {
        const parsed = parseFrame(frame)
        if (parsed) {
          commitment = raiseCommitment(commitment, parsed)
          yield parsed
        }
        frame = takeFrame()
      }
    }

    buffer += decoder.decode()
    let frame = takeFrame()
    while (frame !== undefined) {
      const parsed = parseFrame(frame)
      if (parsed) {
        commitment = raiseCommitment(commitment, parsed)
        yield parsed
      }
      frame = takeFrame()
    }
    // Compatible gateways sometimes close immediately after the final data
    // field instead of writing another blank line. EOF makes that frame
    // complete, so dispatch it rather than silently dropping the last event.
    if (buffer.trim()) {
      const parsed = parseFrame(buffer)
      if (parsed) {
        commitment = raiseCommitment(commitment, parsed)
        yield parsed
      }
    }
    if (!hasTerminalEvent) {
      throw new OpenAIRequestError(
        `${options.label} stream ended before a terminal event`,
        { retryable: !retryWindowClosed() },
      )
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Map OpenAI Responses usage → Anthropic-style mutually exclusive fields.
 *
 * OpenAI:  input_tokens is TOTAL input; cached_tokens ⊆ input_tokens;
 *          cache_write_tokens (GPT-5.6+) reports tokens written this turn.
 * Anthropic: input + cache_creation + cache_read are disjoint and sum to total.
 *
 * Without subtracting cached from input, cacheWarning hit-rate becomes
 * cached/(total+cached) with a hard ceiling of 50%.
 */
export function extractUsage(
  response: Record<string, unknown> | undefined,
): AnthropicUsage {
  const usage = response?.usage as Record<string, unknown> | undefined
  const inputDetails = usage?.input_tokens_details as
    | Record<string, unknown>
    | undefined

  const totalInput =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0

  const cachedRaw =
    typeof inputDetails?.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : 0
  const writeRaw =
    typeof inputDetails?.cache_write_tokens === 'number'
      ? inputDetails.cache_write_tokens
      : 0

  return normalizeOpenAIUsage({
    totalInputTokens: totalInput,
    outputTokens,
    cacheReadTokens: cachedRaw,
    cacheWriteTokens: writeRaw,
  })
}

type ResponsesTermination = {
  stopReason: string
  incompleteReason?: string
}

function mapStopReason(
  eventType: 'response.completed' | 'response.incomplete',
  response: Record<string, unknown> | undefined,
  sawRefusal: boolean,
): ResponsesTermination {
  if (eventType === 'response.completed') return { stopReason: 'end_turn' }

  const incompleteDetails = response?.incomplete_details as
    | Record<string, unknown>
    | undefined
  const reason = incompleteDetails?.reason
  if (reason === 'max_output_tokens') {
    return { stopReason: 'max_tokens', incompleteReason: reason }
  }
  if (reason === 'content_filter') {
    return {
      stopReason: sawRefusal ? 'refusal' : reason,
      incompleteReason: reason,
    }
  }

  const preservedReason = typeof reason === 'string' ? reason : 'missing'
  throw new NonRetryableError(
    `Responses API returned an incomplete response with unsupported reason: ${preservedReason}`,
    { category: 'invalid_request', cause: response },
  )
}

/**
 * Pull the replayable parts out of a `reasoning` output item. Returns null
 * when there is nothing worth replaying.
 *
 * The bar is `encrypted_content`, not "an id or encrypted content". Every
 * request this adapter builds sets `store: false`, so the server keeps no copy
 * of the response and an `rs_…` id resolves to nothing on its own — it is a
 * handle to the payload that travels *beside* it, not a reference the server
 * can look up. Replaying a bare id therefore does not merely waste a token: the
 * next request names an item the server never stored, OpenAI answers
 * `400 Item with id 'rs_…' not found`, and because the item stays on the
 * assistant message it does so again on every following turn of the session.
 *
 * Reachable whenever the response carries reasoning items while the request did
 * not ask for their encrypted payload — `CLAUDE_CODE_EFFORT_LEVEL=auto` takes
 * that branch (see buildResponsesRequest), as does any gateway that ignores
 * `include`. Codex never meets it because it asks for
 * `reasoning.encrypted_content` on every request
 * (codex-rs/core/src/client.rs:894).
 */
export function extractReasoningItem(
  item: Record<string, unknown> | undefined,
): OpenAIReasoningItem | null {
  if (item?.type !== 'reasoning') return null
  const encrypted =
    typeof item.encrypted_content === 'string'
      ? item.encrypted_content
      : undefined
  if (encrypted === undefined) return null
  const id = typeof item.id === 'string' ? item.id : undefined
  return {
    ...(id !== undefined ? { id } : {}),
    encrypted_content: encrypted,
    summary: Array.isArray(item.summary) ? item.summary : [],
  }
}

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
  options?: {
    /**
     * Called for each reasoning item the response produced, in output order.
     * The caller stashes them on the assistant message so the next turn can
     * replay the model's chain of thought.
     */
    onReasoningItem?: (item: OpenAIReasoningItem) => void
  },
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  type ToolBlock = {
    contentIndex: number
    open: boolean
    name: string
    id: string
    /** Bytes delivered by `response.function_call_arguments.delta`. */
    streamedArguments: string
  }
  /**
   * Keyed by every identifier the stream might correlate a tool call with, not
   * by `output_index` alone.
   *
   * `response.function_call_arguments.delta` is specified to carry
   * `output_index`, `item_id` and `call_id`; endpoints do not all send the
   * first. Looking up only `output_index` meant a gateway that omits it landed
   * on the `-1` default, missed the block, and dropped every argument byte on
   * the floor — the tool call still surfaced, with empty input.
   */
  const toolBlocks = new Map<string, ToolBlock>()
  const toolBlockKey = (kind: 'out' | 'item' | 'call', value: unknown) => {
    if (kind === 'out') {
      return typeof value === 'number' && value >= 0
        ? `out:${value}`
        : undefined
    }
    return typeof value === 'string' && value ? `${kind}:${value}` : undefined
  }
  const registerToolBlock = (
    block: ToolBlock,
    keys: Array<string | undefined>,
  ) => {
    for (const key of keys) if (key) toolBlocks.set(key, block)
  }
  const findToolBlock = (
    keys: Array<string | undefined>,
  ): ToolBlock | undefined => {
    for (const key of keys) {
      if (!key) continue
      const block = toolBlocks.get(key)
      if (block) return block
    }
    return undefined
  }
  /**
   * The `tool_use` id this adapter will emit. Derived identically from
   * `.added` and `.done`, so both events resolve to the same block even when
   * the endpoint labels them with nothing else.
   */
  const derivedToolId = (item: Record<string, unknown>, outputIndex: unknown) =>
    String(
      item.call_id ??
        item.id ??
        `call_${typeof outputIndex === 'number' ? outputIndex : -1}`,
    )
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false
  /** Whether the open thinking block has received any text yet. */
  let thinkingHasText = false
  /** `summary_index` of the reasoning summary part currently streaming. */
  let summaryPartIndex: number | undefined
  /** A new summary part starts with the next delta; separate it visually. */
  let pendingSummaryBreak = false
  // This adapter has no idea who is reading its output, so it stays with the
  // conservative rule: any commitment ends the retry window.
  let commitment: ResponseCommitment = 'none'
  let sawRefusal = false

  /** Close whatever is open, then start a `tool_use` block for `item`. */
  function* openToolBlock(
    item: Record<string, unknown>,
    outputIndex: unknown,
  ): Generator<BetaRawMessageStreamEvent, ToolBlock> {
    if (textBlockOpen) {
      yield {
        type: 'content_block_stop',
        index: currentContentIndex,
      } as BetaRawMessageStreamEvent
      textBlockOpen = false
    }
    if (thinkingBlockOpen) {
      yield {
        type: 'content_block_stop',
        index: currentContentIndex,
      } as BetaRawMessageStreamEvent
      thinkingBlockOpen = false
      thinkingHasText = false
    }
    currentContentIndex++
    const id = derivedToolId(item, outputIndex)
    const block: ToolBlock = {
      contentIndex: currentContentIndex,
      open: true,
      name: String(item.name ?? ''),
      id,
      streamedArguments: '',
    }
    registerToolBlock(block, [
      toolBlockKey('out', outputIndex),
      toolBlockKey('item', item.id),
      toolBlockKey('call', item.call_id),
      toolBlockKey('call', id),
    ])
    yield {
      type: 'content_block_start',
      index: currentContentIndex,
      content_block: { type: 'tool_use', id, name: block.name, input: {} },
    } as BetaRawMessageStreamEvent
    return block
  }

  const ensureStarted = async function* () {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as BetaRawMessageStreamEvent
  }

  for await (const event of stream) {
    const sourceError = streamEventError(
      event,
      undefined,
      'Responses API',
      closesRetryWindow(commitment, false),
    )
    if (sourceError) throw sourceError
    commitment = raiseCommitment(commitment, event)
    for await (const startedEvent of ensureStarted()) yield startedEvent
    const type = event.type

    // Refusal text is surfaced as ordinary text: the downstream pipeline has
    // no refusal block type, and hiding it would make the turn end silently.
    if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
      if (type === 'response.refusal.delta') sawRefusal = true
      if (!textBlockOpen) {
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        textBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    // A reasoning summary arrives as several independent parts, each its own
    // paragraph with its own bold header. The Responses API separates them with
    // `response.reasoning_summary_part.added` and a bumped `summary_index`, and
    // carries no newline of its own across the seam — so concatenating the
    // deltas verbatim runs the last sentence of one part into the header of the
    // next. Codex breaks the section on the same signal
    // (codex-rs/tui/src/chatwidget/protocol.rs:88 →
    // `on_reasoning_section_break`, streaming.rs:290).
    if (type === 'response.reasoning_summary_part.added') {
      if (thinkingHasText) pendingSummaryBreak = true
      continue
    }

    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
      if (type === 'response.reasoning_summary_text.delta') {
        const partIndex =
          typeof event.summary_index === 'number'
            ? event.summary_index
            : undefined
        // Second signal, for endpoints that bump the index without sending
        // `part.added` — either alone is enough, and both together break once.
        if (
          partIndex !== undefined &&
          summaryPartIndex !== undefined &&
          partIndex !== summaryPartIndex &&
          thinkingHasText
        ) {
          pendingSummaryBreak = true
        }
        if (partIndex !== undefined) summaryPartIndex = partIndex
      }
      if (!thinkingBlockOpen) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        currentContentIndex++
        thinkingBlockOpen = true
        thinkingHasText = false
        pendingSummaryBreak = false
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }
      if (pendingSummaryBreak) {
        pendingSummaryBreak = false
        yield {
          type: 'content_block_delta',
          index: currentContentIndex,
          delta: { type: 'thinking_delta', thinking: '\n\n' },
        } as BetaRawMessageStreamEvent
      }
      const thinking = String(event.delta ?? '')
      if (thinking) thinkingHasText = true
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'thinking_delta', thinking },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      if (item?.type === 'function_call') {
        yield* openToolBlock(item, event.output_index)
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const block = findToolBlock([
        toolBlockKey('item', event.item_id),
        toolBlockKey('call', event.call_id),
        toolBlockKey('out', event.output_index),
      ])
      if (block) {
        const partialJson = String(event.delta ?? '')
        block.streamedArguments += partialJson
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: { type: 'input_json_delta', partial_json: partialJson },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const doneItem = event.item as Record<string, unknown> | undefined
      const reasoning = extractReasoningItem(doneItem)
      if (reasoning) options?.onReasoningItem?.(reasoning)
      let block = findToolBlock([
        toolBlockKey('item', event.item_id ?? doneItem?.id),
        toolBlockKey('call', event.call_id ?? doneItem?.call_id),
        toolBlockKey('out', event.output_index),
        ...(doneItem
          ? [toolBlockKey('call', derivedToolId(doneItem, event.output_index))]
          : []),
      ])
      // Never announced: an endpoint that emits only `.done` for a completed
      // call would otherwise lose the call entirely. Codex has no `.added`
      // requirement at all — it reconstructs every FunctionCall from this event
      // (codex-rs/codex-api/src/sse/responses.rs:334-341).
      if (!block && doneItem?.type === 'function_call') {
        block = yield* openToolBlock(doneItem, event.output_index)
      }
      if (block?.open) {
        // The completed item carries the whole argument string
        // (codex-rs/protocol/src/models.rs:886), and Codex treats it as the
        // only source — it never reads the delta events. occ keeps streaming
        // the deltas, because a rendering caller wants arguments as they
        // arrive, but falls back here when none came: without this the tool
        // call reaches the executor with input `''`, which fails schema
        // validation on a call the model made correctly.
        const finalArguments = doneItem?.arguments
        if (
          block.streamedArguments.length === 0 &&
          typeof finalArguments === 'string' &&
          finalArguments.length > 0
        ) {
          block.streamedArguments = finalArguments
          yield {
            type: 'content_block_delta',
            index: block.contentIndex,
            delta: { type: 'input_json_delta', partial_json: finalArguments },
          } as BetaRawMessageStreamEvent
        }
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        textBlockOpen = false
      }
      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        thinkingBlockOpen = false
      }
      const response = event.response as Record<string, unknown> | undefined
      const termination = mapStopReason(type, response, sawRefusal)
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: termination.stopReason,
          stop_sequence: null,
          ...(termination.incompleteReason
            ? { incomplete_reason: termination.incompleteReason }
            : {}),
        },
        usage: extractUsage(response),
      } as unknown as BetaRawMessageStreamEvent
      yield { type: 'message_stop' } as BetaRawMessageStreamEvent
    }
  }
}

/**
 * Set once an endpoint has rejected `reasoning.summary`, so the rest of the
 * session stops paying a failed round-trip per turn to re-learn it.
 *
 * Not all `/responses` implementations accept the field: OpenAI requires
 * organization verification for summarizers on its newest reasoning models,
 * and third-party gateways vary. Losing the thinking display is a far better
 * outcome than failing the turn, so a rejection degrades instead of throwing.
 */
let reasoningSummaryRejected = false

function reasoningSummarySupported(): boolean {
  return !reasoningSummaryRejected
}

/** Test-only: undo the process-wide latch between cases. */
export function _resetReasoningSummarySupportForTesting(): void {
  reasoningSummaryRejected = false
}

/**
 * Whether a failed request looks like the endpoint objecting to
 * `reasoning.summary` specifically, rather than to anything else in the body.
 */
function isReasoningSummaryRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const details = getAPIErrorDiagnostics(error)
  const message = [error.message, details.message, details.type, details.code]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase()
  if (!message.includes('summary')) return false
  return (
    message.includes('unknown parameter') ||
    message.includes('unsupported parameter') ||
    message.includes('unsupported value') ||
    message.includes('invalid_request') ||
    message.includes('must be verified') ||
    message.includes('organization must be verified') ||
    message.includes('not supported')
  )
}

/** Strip `reasoning.summary`, leaving the rest of the request untouched. */
function withoutReasoningSummary(request: ResponsesRequest): ResponsesRequest {
  if (!request.reasoning?.summary) return request
  const { summary: _dropped, ...reasoning } = request.reasoning
  return { ...request, reasoning }
}

async function fetchResponsesStream(params: {
  url: string
  headers: Record<string, string>
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  maxRetries?: number
  /** Human-readable route name for error messages. */
  label: string
  /** See {@link closesRetryWindow}. */
  discardsPartialOutput?: boolean
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const discardsPartialOutput = params.discardsPartialOutput === true
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const idleTimeoutMs =
    Number.parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS ?? '', 10) ||
    90_000
  // Read at attempt time, not captured once: the summary-rejection path below
  // reassigns it and re-runs the ladder with a smaller body.
  let request = params.request

  const attempt = async () => {
    const body = JSON.stringify(request)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(params.signal.reason)
    if (params.signal.aborted) forwardAbort()
    else params.signal.addEventListener('abort', forwardAbort, { once: true })
    const cleanup = () =>
      params.signal.removeEventListener('abort', forwardAbort)

    try {
      const response = await fetchFn(params.url, {
        method: 'POST',
        headers: params.headers,
        body,
        signal: controller.signal,
        ...getProxyFetchOptions({ forAnthropicAPI: false }),
      })
      if (!response.ok) {
        throw await createOpenAIResponseError(response, params.label)
      }
      const stream = parseSSE(response, {
        signal: controller.signal,
        abort: reason => controller.abort(reason),
        idleTimeoutMs,
        label: params.label,
        discardsPartialOutput,
      })
      const iterator = stream[Symbol.asyncIterator]()
      const initial: Record<string, unknown>[] = []
      // Everything read here is still ours: it goes into `initial`, and a retry
      // rebuilds `initial` from scratch, so nothing a failed attempt produced
      // can reach the caller. The barrier is therefore the *same* predicate the
      // error stamps use — read past it and a failure is no longer replayable.
      //
      // For a rendering caller that means stopping at the first visible token,
      // which is what keeps time-to-first-token unchanged. A caller that
      // buffers the whole response instead trades nothing away by reading on,
      // and gains a retry for exactly the mid-stream text failures that used to
      // end the turn.
      let commitment: ResponseCommitment = 'none'
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        initial.push(next.value)
        commitment = raiseCommitment(commitment, next.value)
        if (closesRetryWindow(commitment, discardsPartialOutput)) break
      }
      return { controller, cleanup, initial, iterator }
    } catch (error) {
      cleanup()
      if (!controller.signal.aborted) controller.abort(error)
      throw error
    }
  }

  const runLadder = () =>
    retryOpenAIRequest(attempt, {
      signal: params.signal,
      ...(params.maxRetries !== undefined
        ? { maxRetries: params.maxRetries }
        : {}),
    })

  let prepared: Awaited<ReturnType<typeof runLadder>>
  try {
    prepared = await runLadder()
  } catch (error) {
    // A 400 is not retryable, so the ladder above has already given up. If the
    // endpoint objected to `reasoning.summary` in particular, drop it and try
    // once more: losing the thinking display beats losing the turn.
    if (
      !request.reasoning?.summary ||
      !isReasoningSummaryRejection(error) ||
      params.signal.aborted
    ) {
      throw error
    }
    reasoningSummaryRejected = true
    logForDebugging(
      `[OpenAI] ${params.label} rejected reasoning.summary; retrying without it and suppressing it for the rest of the session. Set OPENAI_REASONING_SUMMARY=off to skip this probe.`,
    )
    request = withoutReasoningSummary(request)
    prepared = await runLadder()
  }

  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (const event of prepared.initial) yield event
        while (true) {
          const next = await prepared.iterator.next()
          if (next.done) break
          yield next.value
        }
      } finally {
        prepared.cleanup()
        if (!prepared.controller.signal.aborted) prepared.controller.abort()
        await prepared.iterator.return?.()
      }
    },
  }
}

export async function createChatGPTResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  maxRetries?: number
  /** See {@link closesRetryWindow}. */
  discardsPartialOutput?: boolean
  /**
   * Which set of credential files this call may authenticate from.
   *
   * `'provider'` (the default, and what the main loop passes by omission) is
   * occ's login file or the Codex CLI's. `'search'` adds the login web search
   * pinned for itself, which is the only one that outlives a `/logout` — and
   * refreshes it back into the copy rather than into the login file, so a
   * search cannot resurrect the account the user just signed out of. See
   * chatgptAuth.ts's two source lists.
   */
  authPlane?: 'provider' | 'search'
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const auth =
    params.authPlane === 'search'
      ? await getValidChatGPTAuthForSearch()
      : await getValidChatGPTAuth()
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    Origin: 'https://chatgpt.com',
    Referer: 'https://chatgpt.com/',
    // Deliberately NOT renamed with the rest of the rebrand. This value is
    // sent to chatgpt.com's Codex responses endpoint, which may allowlist or
    // fingerprint known originators; changing it risks breaking
    // ChatGPT-subscription auth in a way that is slow to diagnose. Verify
    // upstream behaviour before touching it.
    originator: 'claude-code-best',
  }
  if (auth.accountId) {
    headers['ChatGPT-Account-Id'] = auth.accountId
  }
  return fetchResponsesStream({
    url: 'https://chatgpt.com/backend-api/codex/responses',
    headers,
    request: params.request,
    signal: params.signal,
    fetchOverride: params.fetchOverride,
    maxRetries: params.maxRetries,
    label: 'ChatGPT Responses API',
    discardsPartialOutput: params.discardsPartialOutput,
  })
}

/**
 * Derive the `/responses` endpoint from the configured base URL. The base is
 * expected to already carry its path prefix (`/v1` on the official API) —
 * identical to the convention the Chat Completions SDK client uses.
 */
export function resolveResponsesEndpoint(baseURL: string | undefined): string {
  return buildProviderResourceURL(
    baseURL?.trim() || 'https://api.openai.com/v1',
    'openai',
    'responses',
  )
}

/**
 * A caller-supplied credential for the generic `/responses` route.
 *
 * ONE OBJECT, NOT TWO PARAMETERS. A key and the endpoint it authenticates
 * against travel together or not at all: an injected key that inherited
 * `OPENAI_BASE_URL` would post the caller's OpenAI secret to whatever
 * third-party gateway the session happens to be configured for, which is worse
 * than the failure the injection exists to fix. `baseURL` left out therefore
 * means OpenAI's own default, never "whatever the env says".
 *
 * The only user today is WebSearch's `codex` source with a credential pinned
 * through /search-setting — that lane has to keep working after a `/logout` or
 * a `/provider use`, both of which delete OPENAI_API_KEY/OPENAI_BASE_URL.
 */
type ResponsesCredential = {
  apiKey: string
  /** Endpoint for `apiKey`. Absent means `https://api.openai.com/v1`. */
  baseURL?: string
}

/**
 * Generic Responses API route: any endpoint speaking the standard
 * `/responses` protocol with API-key auth (official OpenAI or compatible
 * providers). Selected via `OPENAI_WIRE_API=responses`. No ChatGPT-specific
 * headers are sent on this route.
 *
 * `credential` is optional and the main loop never passes it: with it absent
 * every byte of the request — URL, headers, body — is what it was before the
 * parameter existed (`responsesAdapter.test.ts` pins that against a recorded
 * baseline, rather than asserting it in prose).
 */
export async function createOpenAIResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  maxRetries?: number
  /** See {@link closesRetryWindow}. */
  discardsPartialOutput?: boolean
  /** See {@link ResponsesCredential}. Omitted ⇒ the OPENAI_* environment. */
  credential?: ResponsesCredential
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const apiKey = params.credential?.apiKey ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required when OPENAI_WIRE_API=responses is set without ChatGPT auth',
    )
  }
  return fetchResponsesStream({
    url: resolveResponsesEndpoint(
      params.credential
        ? params.credential.baseURL
        : process.env.OPENAI_BASE_URL,
    ),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    request: params.request,
    signal: params.signal,
    fetchOverride: params.fetchOverride,
    maxRetries: params.maxRetries,
    label: 'Responses API',
    discardsPartialOutput: params.discardsPartialOutput,
  })
}
