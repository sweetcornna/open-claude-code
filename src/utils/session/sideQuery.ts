import type Anthropic from '@anthropic-ai/sdk'
import type { BetaToolUnion } from '@anthropic-ai/sdk/resources/beta/messages.js'
import {
  getLastApiCompletionTimestamp,
  getSessionId,
  setLastApiCompletionTimestamp,
} from '../../bootstrap/state.js'
import { STRUCTURED_OUTPUTS_BETA_HEADER } from '../../constants/betas.js'
import type { QuerySource } from '../../constants/querySource.js'
import {
  getAttributionHeader,
  getCLISyspromptPrefix,
} from '../../constants/system.js'
import { logEvent } from '../../services/analytics/index.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/metadata.js'
import { getAPIMetadata } from '../../services/api/claude.js'
import { getAnthropicClient } from '../../services/api/client.js'
import {
  createTrace,
  createChildSpan,
  endTrace,
  recordLLMObservation,
} from '../../services/langfuse/index.js'
import type { LangfuseSpan } from '../../services/langfuse/index.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../services/langfuse/convert.js'
import {
  getModelBetas,
  modelSupportsStructuredOutputs,
} from '../model/betas.js'
import { logForDebugging } from '../telemetry/debug.js'
import { buildProviderResourceURL } from '../network/providerUrl.js'
import { errorMessage } from '../runtime/errors.js'
import { getAPIProvider } from '../model/providers.js'
import { normalizeModelStringForAPI } from '../model/model.js'
import { getOpenAIClient } from '../../services/api/openai/client.js'
import {
  createOpenAIResponseError,
  retryOpenAIRequest,
} from '../../services/api/openai/retry.js'
import { getGrokClient } from '../../services/api/grok/client.js'
import { isChatGPTAuthEnabled } from '../../services/api/openai/chatgptAuth.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  createChatGPTResponsesStream,
  createOpenAIResponsesStream,
} from '../../services/api/openai/responsesAdapter.js'
import { resolveOpenAIWireProtocol } from '../../services/api/openai/wireProtocol.js'
import { isGptFamilyModel } from '../model/chatgptModels.js'
import {
  formatOpenAIPromptCacheKey,
  getOpenAIPromptCacheKey,
  isOfficialOpenAIBaseURL,
} from '../../services/api/openai/openaiShared.js'
import {
  anthropicMessagesToOpenAI,
  resolveOpenAIModel,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
  resolveGrokModel,
  resolveGeminiModel,
  anthropicToolsToGemini,
  anthropicToolChoiceToGemini,
  normalizeGeminiUsage,
  normalizeOpenAIUsage,
  readOpenAICachedTokens,
  readOpenAICacheWriteTokens,
  type GeminiUsageMetadata,
} from '@ant/model-provider'
import type { SystemPrompt } from './systemPromptType.js'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

type MessageParam = Anthropic.MessageParam
type TextBlockParam = Anthropic.TextBlockParam
type Tool = Anthropic.Tool
type ToolChoice = Anthropic.ToolChoice
type BetaMessage = Anthropic.Beta.Messages.BetaMessage
type BetaJSONOutputFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat
type BetaThinkingConfigParam = Anthropic.Beta.Messages.BetaThinkingConfigParam

export type SideQueryOptions = {
  /** Model to use for the query */
  model: string
  /**
   * System prompt - string or array of text blocks (will be prefixed with CLI attribution).
   *
   * The attribution header is always placed in its own TextBlockParam block to ensure
   * server-side parsing correctly extracts the cc_entrypoint value without including
   * system prompt content.
   */
  system?: string | TextBlockParam[]
  /** Messages to send (supports cache_control on content blocks) */
  messages: MessageParam[]
  /** Optional tools (supports both standard Tool[] and BetaToolUnion[] for custom tool types) */
  tools?: Tool[] | BetaToolUnion[]
  /** Optional tool choice (use { type: 'tool', name: 'x' } for forced output) */
  tool_choice?: ToolChoice
  /** Optional JSON output format for structured responses */
  output_format?: BetaJSONOutputFormat
  /** Max tokens (default: 1024) */
  max_tokens?: number
  /** Max retries after the initial attempt (default: 10, clamped to 10) */
  maxRetries?: number
  /** Abort signal */
  signal?: AbortSignal
  /** Skip CLI system prompt prefix (keeps attribution header for OAuth). For internal classifiers that provide their own prompt. */
  skipSystemPromptPrefix?: boolean
  /** Temperature override */
  temperature?: number
  /** Thinking budget (enables thinking), or `false` to send `{ type: 'disabled' }`. */
  thinking?: number | false
  /** Stop sequences — generation stops when any of these strings is emitted */
  stop_sequences?: string[]
  /** Attributes this call in tengu_api_success for COGS joining against reporting.sampling_calls. */
  querySource: QuerySource
  /** Parent Langfuse span to nest this side query under the main agent trace. */
  parentSpan?: LangfuseSpan | null
  /** When true, API failures are recorded as WARNING instead of ERROR in Langfuse.
   *  Use for optional/best-effort queries where failure is expected and handled gracefully. */
  optional?: boolean
}

/**
 * Extract system prompt text from the `system` option.
 */
function extractSystemText(system?: string | TextBlockParam[]): string {
  if (!system) return ''
  if (typeof system === 'string') return system
  return system
    .filter((b): b is { type: 'text'; text: string } => 'text' in b && !!b.text)
    .map(b => b.text)
    .join('\n\n')
}

/**
 * Convert Anthropic MessageParam[] to a list of {role, content} objects
 * suitable for OpenAI-compatible chat.completions APIs.
 */
function messageParamsToOpenAIRoleContent(
  messages: MessageParam[],
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const result: Array<{ role: 'user' | 'assistant'; content: string }> = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text',
              )
              .map(b => b.text)
              .join('\n')
          : ''
    if (text) {
      result.push({ role: m.role as 'user' | 'assistant', content: text })
    }
  }
  return result
}

/**
 * Lightweight API wrapper for "side queries" outside the main conversation loop.
 *
 * Use this instead of direct client.beta.messages.create() calls to ensure
 * proper OAuth token validation with fingerprint attribution headers.
 *
 * This handles:
 * - Fingerprint computation for OAuth validation
 * - Attribution header injection
 * - CLI system prompt prefix
 * - Proper betas for the model
 * - API metadata
 * - Model string normalization (strips [1m] suffix for API)
 * - Third-party provider routing (OpenAI, Grok, Gemini)
 *
 * @example
 * // Permission explainer
 * await sideQuery({ querySource: 'permission_explainer', model, system: SYSTEM_PROMPT, messages, tools, tool_choice })
 *
 * @example
 * // Session search
 * await sideQuery({ querySource: 'session_search', model, system: SEARCH_PROMPT, messages })
 *
 * @example
 * // Model validation
 * await sideQuery({ querySource: 'model_validation', model, max_tokens: 1, messages: [{ role: 'user', content: 'Hi' }] })
 */
export async function sideQuery(opts: SideQueryOptions): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    output_format,
    max_tokens = 1024,
    maxRetries = 10,
    signal,
    skipSystemPromptPrefix,
    temperature,
    thinking,
    stop_sequences,
  } = opts

  const provider = getAPIProvider()
  if (provider === 'openai' || provider === 'grok') {
    return sideQueryViaOpenAICompatible(opts)
  }
  if (provider === 'gemini') {
    return sideQueryViaGemini(opts)
  }

  const betas = [...getModelBetas(model)]
  // Add structured-outputs beta if using output_format and provider supports it
  if (
    output_format &&
    modelSupportsStructuredOutputs(model) &&
    !betas.includes(STRUCTURED_OUTPUTS_BETA_HEADER)
  ) {
    betas.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  const attributionHeader = getAttributionHeader()

  // Build system as array to keep attribution header in its own block
  // (prevents server-side parsing from including system content in cc_entrypoint)
  const systemBlocks: TextBlockParam[] = [
    attributionHeader ? { type: 'text', text: attributionHeader } : null,
    // Skip CLI system prompt prefix for internal classifiers that provide their own prompt
    ...(skipSystemPromptPrefix
      ? []
      : [
          {
            type: 'text' as const,
            text: getCLISyspromptPrefix({
              isNonInteractive: false,
              hasAppendSystemPrompt: false,
            }),
          },
        ]),
    ...(Array.isArray(system)
      ? system
      : system
        ? [{ type: 'text' as const, text: system }]
        : []),
  ].filter((block): block is TextBlockParam => block !== null)

  let thinkingConfig: BetaThinkingConfigParam | undefined
  if (thinking === false) {
    thinkingConfig = { type: 'disabled' }
  } else if (thinking !== undefined) {
    thinkingConfig = {
      type: 'enabled',
      budget_tokens: Math.min(thinking, max_tokens - 1),
    }
  }

  const normalizedModel = normalizeModelStringForAPI(model)
  const start = Date.now()
  const traceName = `side-query:${opts.querySource}`

  // When parentSpan is provided, create a child span nested under the
  // main agent trace; otherwise create a standalone root trace.
  const _ps = opts.parentSpan
  // eslint-disable-next-line no-constant-condition
  if (opts.querySource === 'auto_mode') {
    logForDebugging(
      `[sideQuery] auto_mode parentSpan=${_ps ? `id=${(_ps as unknown as Record<string, unknown>).id ?? 'present'}` : 'null/undefined'} querySource=${opts.querySource}`,
    )
  }
  // When parentSpan is provided, create a child span nested under the
  // main agent trace. For auto_mode queries, we must always nest under
  // a parent span — never create a standalone root trace (agent type),
  // as auto_mode observations should appear as spans within the parent.
  // For other query sources without a parent, create a standalone trace.
  const langfuseTrace = _ps
    ? createChildSpan(_ps, {
        name: traceName,
        sessionId: getSessionId(),
        model: normalizedModel,
        provider,
        querySource: opts.querySource,
      })
    : opts.querySource === 'auto_mode'
      ? null
      : createTrace({
          sessionId: getSessionId(),
          model: normalizedModel,
          provider,
          name: traceName,
          querySource: opts.querySource,
        })

  const request = {
    model: normalizedModel,
    max_tokens,
    system: systemBlocks,
    messages,
    ...(tools && { tools }),
    ...(tool_choice && { tool_choice }),
    ...(output_format && { output_config: { format: output_format } }),
    ...(temperature !== undefined && { temperature }),
    ...(stop_sequences && { stop_sequences }),
    ...(thinkingConfig && { thinking: thinkingConfig }),
    ...(betas.length > 0 && { betas }),
    metadata: getAPIMetadata(),
  }

  const requestSignal = signal ?? new AbortController().signal
  let response: BetaMessage
  try {
    response = await retryOpenAIRequest(
      async () => {
        const client = await getAnthropicClient({
          maxRetries: 0,
          model,
          source: 'side_query',
        })
        return client.beta.messages.create(request, { signal: requestSignal })
      },
      { signal: requestSignal, maxRetries },
    )
  } catch (error) {
    endTrace(
      langfuseTrace,
      { error: errorMessage(error) },
      opts.optional ? 'interrupted' : 'error',
    )
    throw error
  }

  const requestId =
    (response as { _request_id?: string | null })._request_id ?? undefined
  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      normalizedModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cachedInputTokens: response.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  // Record LLM observation in Langfuse (no-op if not configured).
  // Wrap SDK types into the internal message format expected by converters.
  const wrappedInput = messages.map(m => ({
    type: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
    message: { role: m.role, content: m.content },
  })) as unknown as Parameters<typeof convertMessagesToLangfuse>[0]
  const wrappedOutput = [
    {
      type: 'assistant' as const,
      message: { role: 'assistant' as const, content: response.content },
    },
  ] as unknown as Parameters<typeof convertOutputToLangfuse>[0]
  recordLLMObservation(langfuseTrace, {
    model: normalizedModel,
    provider,
    input: convertMessagesToLangfuse(
      wrappedInput,
      systemBlocks.length > 0 ? systemBlocks.map(b => b.text) : undefined,
    ),
    output: convertOutputToLangfuse(wrappedOutput),
    usage: {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_creation_input_tokens:
        response.usage.cache_creation_input_tokens ?? undefined,
      cache_read_input_tokens:
        response.usage.cache_read_input_tokens ?? undefined,
    },
    startTime: new Date(start),
    endTime: new Date(),
    ...(tools && { tools: convertToolsToLangfuse(tools as unknown[]) }),
    ...(thinkingConfig &&
      thinkingConfig.type !== 'disabled' && {
        thinking: {
          type: thinkingConfig.type,
          ...(thinkingConfig.type === 'enabled' && {
            budgetTokens: thinkingConfig.budget_tokens,
          }),
        },
      }),
  })
  endTrace(langfuseTrace)

  return response
}

/**
 * Collect Anthropic stream events from the ChatGPT Responses adapter into a
 * single BetaMessage for side-query callers (classifiers, explainers, etc.).
 */
async function collectAnthropicStreamToBetaMessage(
  stream: AsyncIterable<BetaRawMessageStreamEvent>,
  fallbackModel: string,
): Promise<BetaMessage> {
  let messageId = `msg_side_${Date.now()}`
  let model = fallbackModel
  let stopReason: BetaMessage['stop_reason'] = 'end_turn'
  let usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const contentBlocks: Record<number, Record<string, unknown>> = {}

  for await (const event of stream) {
    switch (event.type) {
      case 'message_start': {
        messageId = event.message.id
        model = event.message.model || model
        if (event.message.usage) {
          usage = {
            input_tokens: event.message.usage.input_tokens ?? 0,
            output_tokens: event.message.usage.output_tokens ?? 0,
            cache_creation_input_tokens:
              event.message.usage.cache_creation_input_tokens ?? 0,
            cache_read_input_tokens:
              event.message.usage.cache_read_input_tokens ?? 0,
          }
        }
        break
      }
      case 'content_block_start': {
        const cb = event.content_block as unknown as Record<string, unknown>
        if (cb.type === 'tool_use') {
          contentBlocks[event.index] = { ...cb, input: '' }
        } else if (cb.type === 'text') {
          contentBlocks[event.index] = { ...cb, text: '' }
        } else if (cb.type === 'thinking') {
          contentBlocks[event.index] = {
            ...cb,
            thinking: '',
            signature: '',
          }
        } else {
          contentBlocks[event.index] = { ...cb }
        }
        break
      }
      case 'content_block_delta': {
        const block = contentBlocks[event.index]
        if (!block) break
        const delta = event.delta as {
          type: string
          text?: string
          partial_json?: string
          thinking?: string
          signature?: string
        }
        if (delta.type === 'text_delta') {
          block.text = String(block.text ?? '') + String(delta.text ?? '')
        } else if (delta.type === 'input_json_delta') {
          block.input =
            String(block.input ?? '') + String(delta.partial_json ?? '')
        } else if (delta.type === 'thinking_delta') {
          block.thinking =
            String(block.thinking ?? '') + String(delta.thinking ?? '')
        } else if (delta.type === 'signature_delta') {
          block.signature = delta.signature
        }
        break
      }
      case 'message_delta': {
        const delta = event.delta as {
          stop_reason?: BetaMessage['stop_reason']
        }
        if (delta.stop_reason != null) {
          stopReason = delta.stop_reason
        }
        const deltaUsage = (
          event as {
            usage?: {
              input_tokens?: number
              output_tokens?: number
              cache_creation_input_tokens?: number
              cache_read_input_tokens?: number
            }
          }
        ).usage
        if (deltaUsage) {
          if (typeof deltaUsage.input_tokens === 'number') {
            usage.input_tokens = deltaUsage.input_tokens
          }
          if (typeof deltaUsage.output_tokens === 'number') {
            usage.output_tokens = deltaUsage.output_tokens
          }
          if (
            typeof deltaUsage.cache_creation_input_tokens === 'number' &&
            deltaUsage.cache_creation_input_tokens > 0
          ) {
            usage.cache_creation_input_tokens =
              deltaUsage.cache_creation_input_tokens
          }
          if (
            typeof deltaUsage.cache_read_input_tokens === 'number' &&
            deltaUsage.cache_read_input_tokens > 0
          ) {
            usage.cache_read_input_tokens = deltaUsage.cache_read_input_tokens
          }
        }
        break
      }
      default:
        break
    }
  }

  const content = Object.keys(contentBlocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map(index => {
      const block = contentBlocks[index]!
      if (block.type === 'tool_use') {
        const rawInput = block.input
        let parsed: unknown = {}
        if (typeof rawInput === 'string' && rawInput.length > 0) {
          try {
            parsed = JSON.parse(rawInput)
          } catch {
            parsed = {}
          }
        } else if (rawInput && typeof rawInput === 'object') {
          parsed = rawInput
        }
        return {
          type: 'tool_use' as const,
          id: String(block.id ?? `toolu_${index}`),
          name: String(block.name ?? ''),
          input: parsed,
        }
      }
      if (block.type === 'thinking') {
        return {
          type: 'thinking' as const,
          thinking: String(block.thinking ?? ''),
          signature: String(block.signature ?? ''),
        }
      }
      return {
        type: 'text' as const,
        text: String(block.text ?? ''),
      }
    })

  // Forced tool_choice classifiers care about tool_use blocks, not stop_reason
  // from the Responses adapter (which often reports end_turn even with tools).
  if (content.some(b => b.type === 'tool_use') && stopReason === 'end_turn') {
    stopReason = 'tool_use'
  }

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: content as BetaMessage['content'],
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage,
  } as BetaMessage
}

/**
 * Floor for `max_output_tokens` on the API-key Responses route.
 *
 * Side queries ask for 1024 tokens by default, which is right for Chat
 * Completions but not for `/responses`: there the budget also has to cover
 * reasoning tokens, and a reasoning model can burn the whole 1024 before
 * emitting a single visible token — the caller then sees an empty classifier
 * answer rather than an error. The ChatGPT/Codex route sends no cap at all
 * (that backend rejects the field), so this only applies to API-key endpoints.
 */
const RESPONSES_SIDE_QUERY_MIN_OUTPUT_TOKENS = 4096

/**
 * Side query over the Responses API — both routes it serves:
 *
 *   'chatgpt' — ChatGPT subscription OAuth against the Codex backend. Must not
 *     use getOpenAIClient(): that path only reads OPENAI_API_KEY and yields 401
 *     under OPENAI_AUTH_MODE=chatgpt (no API key configured).
 *   'apikey'  — any endpoint speaking `/responses` with an API key, selected by
 *     OPENAI_WIRE_API=responses or a Codex-family model id. Without this,
 *     picking the Responses protocol only moved the main loop: every side query
 *     still went out as Chat Completions, which a Responses-only upstream
 *     rejects outright.
 */
async function sideQueryViaResponsesApi(
  opts: SideQueryOptions,
  route: 'chatgpt' | 'apikey',
  openaiModel: string,
  openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }>,
  openaiTools: unknown[] | undefined,
  openaiToolChoice: unknown,
): Promise<BetaMessage> {
  const start = Date.now()
  const request = buildResponsesRequest({
    model: openaiModel,
    messages: openaiMessages,
    tools: openaiTools ?? [],
    toolChoice: openaiToolChoice,
    ...(isGptFamilyModel(openaiModel) ? { reasoningEffort: 'low' } : {}),
    // No UI renders a side query's thinking, and the summary would spend part
    // of an output budget that reasoning tokens already strain (see the
    // max_output_tokens floor below).
    reasoningSummary: 'off',
    ...(route === 'chatgpt'
      ? { promptCacheKey: formatOpenAIPromptCacheKey(getSessionId()) }
      : {
          // This branch is the generic `/responses` route, where
          // prompt_cache_key is a standard field — see
          // shouldSendOpenAIPromptCacheKey for the per-protocol defaults.
          promptCacheKey: getOpenAIPromptCacheKey(
            process.env.OPENAI_BASE_URL,
            getSessionId(),
            'responses',
          ),
          maxOutputTokens: Math.max(
            opts.max_tokens ?? 1024,
            RESPONSES_SIDE_QUERY_MIN_OUTPUT_TOKENS,
          ),
        }),
  })

  const signal = opts.signal ?? new AbortController().signal
  const maxRetries = opts.maxRetries ?? 10
  const rawStream =
    route === 'chatgpt'
      ? await createChatGPTResponsesStream({ request, signal, maxRetries })
      : await createOpenAIResponsesStream({ request, signal, maxRetries })
  const adapted = adaptResponsesStreamToAnthropic(rawStream, openaiModel)
  const betaMessage = await collectAnthropicStreamToBetaMessage(
    adapted,
    openaiModel,
  )

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      betaMessage.id as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      openaiModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: betaMessage.usage.input_tokens,
    outputTokens: betaMessage.usage.output_tokens,
    cachedInputTokens: betaMessage.usage.cache_read_input_tokens ?? 0,
    uncachedInputTokens: betaMessage.usage.input_tokens,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  return betaMessage
}

/**
 * OpenAI-compatible side query for OpenAI and Grok providers.
 * Both use the OpenAI SDK with different base URLs.
 *
 * Converts Anthropic-format params to OpenAI Chat Completions, sends a
 * non-streaming request, and wraps the response back into a BetaMessage
 * shape so callers remain provider-agnostic.
 *
 * OpenAI side queries follow the same wire-protocol resolution as the main
 * loop, so a session on `/responses` never silently drops back to
 * `/chat/completions` for its classifiers (see sideQueryViaResponsesApi).
 *
 * Supports tools and tool_choice for structured output (e.g. yoloClassifier,
 * permissionExplainer).
 */
async function sideQueryViaOpenAICompatible(
  opts: SideQueryOptions,
): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    max_tokens = 1024,
    temperature,
    signal,
  } = opts

  const provider = getAPIProvider()
  const normalizedModel = normalizeModelStringForAPI(model)

  // Resolve model name per provider
  const openaiModel =
    provider === 'grok'
      ? resolveGrokModel(normalizedModel)
      : resolveOpenAIModel(normalizedModel)

  // Build system prompt text
  const systemText = extractSystemText(system)

  // Build OpenAI messages: system first, then user/assistant
  const openaiMessages: Array<{
    role: 'system' | 'user' | 'assistant'
    content: string
  }> = []
  if (systemText) {
    openaiMessages.push({ role: 'system', content: systemText })
  }
  openaiMessages.push(...messageParamsToOpenAIRoleContent(messages))

  // Convert tools and tool_choice if provided
  const openaiTools =
    tools && tools.length > 0
      ? anthropicToolsToOpenAI(tools as BetaToolUnion[])
      : undefined
  const openaiToolChoice = tool_choice
    ? anthropicToolChoiceToOpenAI(tool_choice)
    : undefined

  // Wire protocol follows the main loop (openai/wireProtocol.ts): ChatGPT
  // subscription auth is Responses-over-OAuth, an explicit
  // OPENAI_WIRE_API=responses or a Codex-family model is Responses-over-API-key,
  // everything else is Chat Completions. Grok is Chat Completions only.
  if (provider === 'openai') {
    if (isChatGPTAuthEnabled()) {
      return sideQueryViaResponsesApi(
        opts,
        'chatgpt',
        openaiModel,
        openaiMessages,
        openaiTools,
        openaiToolChoice,
      )
    }
    if (resolveOpenAIWireProtocol(openaiModel) === 'responses') {
      return sideQueryViaResponsesApi(
        opts,
        'apikey',
        openaiModel,
        openaiMessages,
        openaiTools,
        openaiToolChoice,
      )
    }
  }

  // API-key / OpenAI-compatible / Grok: Chat Completions
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  const client: import('openai').default =
    provider === 'grok'
      ? getGrokClient({ maxRetries: 0 })
      : getOpenAIClient({ maxRetries: 0 })

  const start = Date.now()

  const requestParams: Record<string, unknown> = {
    model: openaiModel,
    messages: openaiMessages,
    max_tokens,
  }
  const promptCacheKey =
    provider === 'openai'
      ? getOpenAIPromptCacheKey(process.env.OPENAI_BASE_URL, getSessionId())
      : undefined
  if (promptCacheKey) requestParams.prompt_cache_key = promptCacheKey
  if (temperature !== undefined) requestParams.temperature = temperature
  if (openaiTools && openaiTools.length > 0) {
    requestParams.tools = openaiTools
    if (openaiToolChoice) requestParams.tool_choice = openaiToolChoice
  }

  const requestSignal = signal ?? new AbortController().signal
  const response = await retryOpenAIRequest(
    () =>
      client.chat.completions.create(
        requestParams as unknown as import('openai/resources/chat/completions/completions.mjs').ChatCompletionCreateParamsNonStreaming,
        { signal: requestSignal },
      ),
    {
      signal: requestSignal,
      maxRetries: opts.maxRetries ?? 10,
    },
  )

  const choice = response.choices[0]
  const message = choice?.message

  // Build content blocks for BetaMessage
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  > = []

  if (message?.content) {
    contentBlocks.push({ type: 'text', text: message.content })
  }

  if (message?.tool_calls) {
    for (const tc of message.tool_calls) {
      // ChatCompletionMessageToolCall is a union — only function-type has .function
      if (tc.type === 'function' && 'function' in tc) {
        const fn = (tc as { function: { name: string; arguments: string } })
          .function
        contentBlocks.push({
          type: 'tool_use',
          id: tc.id ?? `toolu_${Date.now()}`,
          name: fn.name,
          input: JSON.parse(fn.arguments || '{}'),
        })
      }
    }
  }

  const responseUsage = response.usage
  // Same field-preference order as the streaming adapter (OpenAI spelling,
  // then DeepSeek's, then the flattened proxy form) — reading only the OpenAI
  // spelling reported a 0% hit rate on providers that use the others.
  const usage = normalizeOpenAIUsage({
    totalInputTokens: responseUsage?.prompt_tokens ?? 0,
    outputTokens: responseUsage?.completion_tokens ?? 0,
    cacheReadTokens: readOpenAICachedTokens(responseUsage) ?? 0,
    // Cache-write tokens are an OpenAI-only usage field. Gated on the endpoint,
    // not on promptCacheKey: the key is now sent optimistically everywhere
    // (see shouldSendOpenAIPromptCacheKey), so its presence no longer implies
    // this request went to OpenAI's own endpoint.
    cacheWriteTokens: isOfficialOpenAIBaseURL(process.env.OPENAI_BASE_URL)
      ? (readOpenAICacheWriteTokens(responseUsage) ?? 0)
      : 0,
  })

  const now = Date.now()
  const requestId = response.id
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId:
      requestId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      openaiModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens,
    uncachedInputTokens: usage.cache_creation_input_tokens,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  const stopReason =
    choice?.finish_reason === 'tool_calls'
      ? 'tool_use'
      : choice?.finish_reason === 'length'
        ? 'max_tokens'
        : 'end_turn'

  return {
    id: response.id,
    type: 'message',
    role: 'assistant',
    content: contentBlocks as BetaMessage['content'],
    model: openaiModel,
    stop_reason: stopReason as BetaMessage['stop_reason'],
    stop_sequence: null,
    usage,
  } as BetaMessage
}

/**
 * Gemini side query. Converts Anthropic-format params to Gemini
 * generateContent format, sends a non-streaming request via fetch,
 * and wraps the response back into a BetaMessage shape.
 */
async function sideQueryViaGemini(
  opts: SideQueryOptions,
): Promise<BetaMessage> {
  const {
    model,
    system,
    messages,
    tools,
    tool_choice,
    max_tokens = 1024,
    temperature,
    signal,
  } = opts

  const normalizedModel = normalizeModelStringForAPI(model)
  const geminiModel = resolveGeminiModel(normalizedModel)

  // Build Gemini contents from Anthropic MessageParam[]
  const contents: Array<{
    role: 'user' | 'model'
    parts: Array<{ text: string }>
  }> = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const text =
      typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter(
                (b): b is { type: 'text'; text: string } => b.type === 'text',
              )
              .map(b => b.text)
              .join('\n')
          : ''
    if (text) {
      contents.push({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text }],
      })
    }
  }

  // Build system instruction
  const systemText = extractSystemText(system)
  const systemInstruction = systemText
    ? { parts: [{ text: systemText }] }
    : undefined

  // Convert tools and tool_choice
  const geminiTools =
    tools && tools.length > 0
      ? anthropicToolsToGemini(tools as BetaToolUnion[])
      : undefined
  const geminiToolConfig = tool_choice
    ? anthropicToolChoiceToGemini(tool_choice)
    : undefined

  const modelPath = geminiModel.startsWith('models/')
    ? geminiModel
    : `models/${geminiModel}`
  const url = buildProviderResourceURL(
    process.env.GEMINI_BASE_URL ||
      'https://generativelanguage.googleapis.com/v1beta',
    'gemini',
    `${modelPath}:generateContent`,
  )

  const body: Record<string, unknown> = {
    contents,
    ...(systemInstruction && { systemInstruction }),
    ...(geminiTools && geminiTools.length > 0 && { tools: geminiTools }),
    ...(geminiToolConfig && {
      toolConfig: { functionCallingConfig: geminiToolConfig },
    }),
    ...(temperature !== undefined && {
      generationConfig: { temperature },
    }),
    ...(max_tokens !== undefined && {
      generationConfig: {
        ...(temperature !== undefined && { temperature }),
        maxOutputTokens: max_tokens,
      },
    }),
  }

  // Merge generationConfig if both temperature and max_tokens are set
  if (temperature !== undefined && max_tokens !== undefined) {
    body.generationConfig = { temperature, maxOutputTokens: max_tokens }
  }

  const start = Date.now()

  const requestSignal = signal ?? new AbortController().signal
  const res = await retryOpenAIRequest(
    async () => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY || '',
        },
        body: JSON.stringify(body),
        signal: requestSignal,
      })
      if (!response.ok) {
        throw await createOpenAIResponseError(response, 'Gemini API')
      }
      return response
    },
    {
      signal: requestSignal,
      maxRetries: opts.maxRetries ?? 10,
    },
  )

  const geminiResponse = (await res.json()) as {
    candidates?: Array<{
      content?: {
        role?: string
        parts?: Array<{
          text?: string
          functionCall?: { name?: string; args?: Record<string, unknown> }
        }>
      }
      finishReason?: string
    }>
    usageMetadata?: GeminiUsageMetadata & { totalTokenCount?: number }
    id?: string
  }
  // Shared with the streaming adapter: subtracts the cached prefix out of
  // promptTokenCount (Gemini counts it inside the total) and folds thinking
  // tokens into the output count.
  const geminiUsage = normalizeGeminiUsage(geminiResponse.usageMetadata)

  // Build content blocks from Gemini response
  const contentBlocks: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  > = []

  const candidate = geminiResponse.candidates?.[0]
  const parts = candidate?.content?.parts
  if (parts) {
    for (const part of parts) {
      if (part.text) {
        contentBlocks.push({ type: 'text', text: part.text })
      }
      if (part.functionCall) {
        contentBlocks.push({
          type: 'tool_use',
          id: `toolu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          name: part.functionCall.name ?? '',
          input: part.functionCall.args ?? {},
        })
      }
    }
  }

  const now = Date.now()
  const lastCompletion = getLastApiCompletionTimestamp()
  logEvent('tengu_api_success', {
    requestId: (geminiResponse.id ??
      '') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    querySource:
      opts.querySource as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    model:
      geminiModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    inputTokens: geminiUsage.input_tokens,
    outputTokens: geminiUsage.output_tokens,
    cachedInputTokens: geminiUsage.cache_read_input_tokens,
    uncachedInputTokens: geminiUsage.cache_creation_input_tokens,
    durationMsIncludingRetries: now - start,
    timeSinceLastApiCallMs:
      lastCompletion !== null ? now - lastCompletion : undefined,
  })
  setLastApiCompletionTimestamp(now)

  const stopReason =
    candidate?.finishReason === 'STOP'
      ? 'end_turn'
      : candidate?.finishReason === 'MAX_TOKENS'
        ? 'max_tokens'
        : 'end_turn'

  return {
    id: geminiResponse.id ?? `gemini_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content: contentBlocks as BetaMessage['content'],
    model: geminiModel,
    stop_reason: stopReason as BetaMessage['stop_reason'],
    stop_sequence: null,
    usage: geminiUsage,
  } as BetaMessage
}
