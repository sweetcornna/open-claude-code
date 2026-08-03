import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import { normalizeOpenAIUsage, type AnthropicUsage } from '@ant/model-provider'
import { getValidChatGPTAuth } from './chatgptAuth.js'

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = Record<string, unknown>
export type ResponsesReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

type ResponsesRequest = {
  model: string
  stream: true
  store: false
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: { effort: ResponsesReasoningEffort }
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
      const text = textFromContent(record.content)
      if (text) {
        input.push({ role: 'assistant', content: text })
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
  /**
   * ChatGPT OAuth route: always set (session-scoped). Generic route: set only
   * for OpenAI's official endpoint — compatible providers must not receive
   * OpenAI-specific request parameters.
   */
  promptCacheKey?: string
  /** Generic `/responses` endpoints only — the ChatGPT backend rejects it. */
  maxOutputTokens?: number
}): ResponsesRequest {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
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
      ? { reasoning: { effort: params.reasoningEffort } }
      : {}),
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

async function* parseSSE(
  response: Response,
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body)
    throw new Error('Responses API stream did not include a body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const parseFrame = (frame: string): Record<string, unknown> | undefined => {
    const data = frame
      .split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n')
    if (!data || data === '[DONE]') return undefined
    const parsed = JSON.parse(data) as unknown
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined
  }

  const takeFrame = (): string | undefined => {
    // Match the two wire forms explicitly. A generic "two line endings"
    // regex can backtrack and misread one CRLF as a CR frame ending followed
    // by an LF blank line when the pair is split across reads.
    const boundary = buffer.match(/\r\n\r\n|\n\n/)
    if (boundary?.index === undefined) return undefined
    const frame = buffer.slice(0, boundary.index)
    buffer = buffer.slice(boundary.index + boundary[0].length)
    return frame
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let frame = takeFrame()
    while (frame !== undefined) {
      const parsed = parseFrame(frame)
      if (parsed) yield parsed
      frame = takeFrame()
    }
  }

  buffer += decoder.decode()
  let frame = takeFrame()
  while (frame !== undefined) {
    const parsed = parseFrame(frame)
    if (parsed) yield parsed
    frame = takeFrame()
  }
  // Compatible gateways sometimes close immediately after the final data
  // field instead of writing another blank line. EOF makes that frame
  // complete, so dispatch it rather than silently dropping the last event.
  if (buffer.trim()) {
    const parsed = parseFrame(buffer)
    if (parsed) yield parsed
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

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
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

async function fetchResponsesStream(params: {
  url: string
  headers: Record<string, string>
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  /** Human-readable route name for error messages. */
  label: string
}): Promise<AsyncIterable<Record<string, unknown>>> {
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const response = await fetchFn(params.url, {
    method: 'POST',
    headers: params.headers,
    body: JSON.stringify(params.request),
    signal: params.signal,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(
      `${params.label} request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    )
  }
  return parseSSE(response)
}

export async function createChatGPTResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
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
    label: 'ChatGPT Responses API',
  })
}

/**
 * Derive the `/responses` endpoint from the configured base URL. The base is
 * expected to already carry its path prefix (`/v1` on the official API) —
 * identical to the convention the Chat Completions SDK client uses.
 */
export function resolveResponsesEndpoint(baseURL: string | undefined): string {
  const base = (baseURL?.trim() || 'https://api.openai.com/v1').replace(
    /\/+$/,
    '',
  )
  return `${base}/responses`
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
    label: 'Responses API',
  })
}
