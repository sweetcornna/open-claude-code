import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import {
  normalizeOpenAIUsage,
  readReasoningItems,
  type AnthropicUsage,
  type OpenAIReasoningItem,
} from '@ant/model-provider'
import { getValidChatGPTAuth } from './chatgptAuth.js'
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
  createOpenAIResponseError,
  OpenAIRequestError,
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

const NON_COMMITTING_RESPONSE_EVENTS = new Set([
  'response.created',
  'response.in_progress',
  'response.queued',
])

function commitsResponseAttempt(event: Record<string, unknown>): boolean {
  return (
    typeof event.type !== 'string' ||
    !NON_COMMITTING_RESPONSE_EVENTS.has(event.type)
  )
}

function streamEventError(
  event: Record<string, unknown>,
  label: string,
): OpenAIRequestError | undefined {
  const type = event.type
  if (type !== 'response.error' && type !== 'response.failed') return undefined
  const container =
    type === 'response.failed' &&
    event.response &&
    typeof event.response === 'object'
      ? (event.response as Record<string, unknown>)
      : event
  const error =
    container.error && typeof container.error === 'object'
      ? (container.error as Record<string, unknown>)
      : undefined
  const code = typeof error?.code === 'string' ? error.code : ''
  const message =
    typeof error?.message === 'string'
      ? error.message
      : `${label} stream returned ${type}`
  const detail = `${code} ${message}`
  const permanent =
    /auth|api.?key|permission|forbidden|invalid.?request|invalid.?argument|invalid.?parameter|bad.?request|model.?not.?found|unknown.?model|does not exist|context.?length/i.test(
      detail,
    )
  const transient =
    /server.?error|rate.?limit|timeout|timed.?out|overload|temporar|upstream|unavailable|internal.?error|bad.?gateway|gateway/i.test(
      detail,
    )
  return new OpenAIRequestError(`${label} stream failed: ${message}`, {
    retryable: !permanent && transient,
  })
}

async function* parseSSE(
  response: Response,
  options: {
    signal: AbortSignal
    abort: (reason: Error) => void
    idleTimeoutMs: number
    label: string
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
  let hasCommittedEvent = false

  const parseFrame = (frame: string): Record<string, unknown> | undefined => {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return undefined
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch (cause) {
      throw new OpenAIRequestError(
        `${options.label} stream returned invalid SSE JSON`,
        { retryable: !hasCommittedEvent, cause },
      )
    }
    if (!parsed || typeof parsed !== 'object') return undefined
    const event = parsed as Record<string, unknown>
    const error = streamEventError(event, options.label)
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
          { retryable: !hasCommittedEvent },
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
      const { done, value } = await read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let frame = takeFrame()
      while (frame !== undefined) {
        const parsed = parseFrame(frame)
        if (parsed) {
          if (commitsResponseAttempt(parsed)) hasCommittedEvent = true
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
        if (commitsResponseAttempt(parsed)) hasCommittedEvent = true
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
        if (commitsResponseAttempt(parsed)) hasCommittedEvent = true
        yield parsed
      }
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

function mapStopReason(response: Record<string, unknown> | undefined): string {
  if (response?.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

/**
 * Pull the replayable parts out of a `reasoning` output item. Returns null
 * when there is nothing worth replaying — an item with neither an id nor
 * encrypted content carries no recoverable reasoning, so echoing it back
 * would only add a token the model cannot use.
 */
export function extractReasoningItem(
  item: Record<string, unknown> | undefined,
): OpenAIReasoningItem | null {
  if (item?.type !== 'reasoning') return null
  const id = typeof item.id === 'string' ? item.id : undefined
  const encrypted =
    typeof item.encrypted_content === 'string'
      ? item.encrypted_content
      : undefined
  if (id === undefined && encrypted === undefined) return null
  return {
    ...(id !== undefined ? { id } : {}),
    ...(encrypted !== undefined ? { encrypted_content: encrypted } : {}),
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
  const toolBlocks = new Map<
    number,
    { contentIndex: number; open: boolean; name: string; id: string }
  >()
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false

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
    for await (const startedEvent of ensureStarted()) yield startedEvent
    const type = event.type

    // Refusal text is surfaced as ordinary text: the downstream pipeline has
    // no refusal block type, and hiding it would make the turn end silently.
    if (
      type === 'response.output_text.delta' ||
      type === 'response.refusal.delta'
    ) {
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

    if (
      type === 'response.reasoning_text.delta' ||
      type === 'response.reasoning_summary_text.delta'
    ) {
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
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'thinking_delta', thinking: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      if (item?.type === 'function_call' && outputIndex >= 0) {
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
        currentContentIndex++
        const id = String(item.call_id ?? item.id ?? `call_${outputIndex}`)
        const name = String(item.name ?? '')
        toolBlocks.set(outputIndex, {
          contentIndex: currentContentIndex,
          open: true,
          name,
          id,
        })
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block) {
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: String(event.delta ?? ''),
          },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const doneItem = event.item as Record<string, unknown> | undefined
      const reasoning = extractReasoningItem(doneItem)
      if (reasoning) options?.onReasoningItem?.(reasoning)
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block?.open) {
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'response.error') {
      const error = event.error as Record<string, unknown> | undefined
      throw new Error(String(error?.message ?? 'ChatGPT Responses API error'))
    }

    if (type === 'response.failed') {
      const response = event.response as Record<string, unknown> | undefined
      const error = response?.error as Record<string, unknown> | undefined
      throw new Error(String(error?.message ?? 'ChatGPT Responses API failed'))
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
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(response), stop_sequence: null },
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
  const message = error.message.toLowerCase()
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
}): Promise<AsyncIterable<Record<string, unknown>>> {
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
      })
      const iterator = stream[Symbol.asyncIterator]()
      const initial: Record<string, unknown>[] = []
      while (true) {
        const next = await iterator.next()
        if (next.done) break
        initial.push(next.value)
        if (commitsResponseAttempt(next.value)) break
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
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const auth = await getValidChatGPTAuth()
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
 * Generic Responses API route: any endpoint speaking the standard
 * `/responses` protocol with API-key auth (official OpenAI or compatible
 * providers). Selected via `OPENAI_WIRE_API=responses`. No ChatGPT-specific
 * headers are sent on this route.
 */
export async function createOpenAIResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  maxRetries?: number
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is required when OPENAI_WIRE_API=responses is set without ChatGPT auth',
    )
  }
  return fetchResponsesStream({
    url: resolveResponsesEndpoint(process.env.OPENAI_BASE_URL),
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
  })
}
