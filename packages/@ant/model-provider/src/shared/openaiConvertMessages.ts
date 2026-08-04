import type {
  BetaContentBlockParam,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionMessageParam,
  ChatCompletionSystemMessageParam,
  ChatCompletionToolMessageParam,
  ChatCompletionUserMessageParam,
} from 'openai/resources/chat/completions/completions.mjs'
import type { AssistantMessage, UserMessage } from '../types/message.js'
import type { SystemPrompt } from '../types/systemPrompt.js'

export interface ConvertMessagesOptions {
  /** When true, preserve thinking blocks as reasoning_content on assistant messages
   *  (required for DeepSeek thinking mode with tool calls). */
  enableThinking?: boolean
  /**
   * Carry {@link OPENAI_REASONING_ITEMS_FIELD} through onto the converted
   * assistant message. Responses-API only — see the field's own doc comment.
   * Off by default so Chat Completions bodies never grow an unknown key that
   * strict OpenAI-compatible endpoints would reject.
   */
  preserveReasoningItems?: boolean
}

/**
 * A reasoning item as the Responses API returned it, kept verbatim so it can
 * be echoed back on the next turn.
 */
export type OpenAIReasoningItem = {
  id?: string
  encrypted_content?: string
  summary?: unknown[]
}

/**
 * Field on an AssistantMessage's `message` object holding the reasoning items
 * the Responses API produced for that turn.
 *
 * Reasoning models served over `/responses` with `store: false` keep no
 * server-side state, so the reasoning items from turn N are gone unless the
 * client replays them in turn N+1's `input`. Without the replay the model
 * re-derives its chain of thought from scratch on every follow-up — which
 * matters most in agentic loops, where a turn is often just a tool call and
 * the reasoning behind it is the only thing carrying intent forward.
 *
 * This is a fidelity fix, not a cache fix. Measured against a live endpoint
 * (6-turn conversation, replay on vs off, everything else held constant) the
 * cumulative hit rate was identical at 80.9% either way: OpenAI's prefix
 * cache matches against the client's own previous *request*, and a client
 * that consistently omits reasoning still chains cleanly with itself.
 *
 * Lives on the message rather than on a content block: block-level metadata
 * would ride along into a request to a different provider if the user
 * switches models mid-session, whereas message-level extras are dropped by
 * every provider's message->param conversion.
 */
export const OPENAI_REASONING_ITEMS_FIELD = '_openaiReasoningItems'

/** Read back the reasoning items stashed on an assistant message, if any. */
export function readReasoningItems(
  message: Record<string, unknown> | undefined,
): OpenAIReasoningItem[] {
  const raw = message?.[OPENAI_REASONING_ITEMS_FIELD]
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (item): item is OpenAIReasoningItem =>
      typeof item === 'object' && item !== null,
  )
}

/**
 * Convert internal (UserMessage | AssistantMessage)[] to OpenAI-format messages.
 *
 * Key conversions:
 * - system prompt → role: "system" message prepended
 * - tool_use blocks → tool_calls[] on assistant message
 * - tool_result blocks → role: "tool" messages
 * - thinking blocks → preserved as reasoning_content (DeepSeek requires passing it back)
 * - cache_control → stripped
 */
export function anthropicMessagesToOpenAI(
  messages: (UserMessage | AssistantMessage)[],
  systemPrompt: SystemPrompt,
  // enableThinking is retained for API compatibility; thinking blocks are now always preserved
  options?: ConvertMessagesOptions,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []

  // Prepend system prompt as system message
  const systemText = systemPromptToText(systemPrompt)
  if (systemText) {
    result.push({
      role: 'system',
      content: systemText,
    } satisfies ChatCompletionSystemMessageParam)
  }

  for (const msg of messages) {
    switch (msg.type) {
      case 'user':
        result.push(...convertInternalUserMessage(msg))
        break
      case 'assistant':
        result.push(...convertInternalAssistantMessage(msg, options))
        break
      default:
        break
    }
  }

  return result
}

function systemPromptToText(systemPrompt: SystemPrompt): string {
  if (!systemPrompt || systemPrompt.length === 0) return ''
  return systemPrompt.filter(Boolean).join('\n\n')
}

function convertInternalUserMessage(
  msg: UserMessage,
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = []
  const content = msg.message.content

  if (typeof content === 'string') {
    result.push({
      role: 'user',
      content,
    } satisfies ChatCompletionUserMessageParam)
  } else if (Array.isArray(content)) {
    const textParts: string[] = []
    const toolResults: BetaToolResultBlockParam[] = []
    const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> =
      []

    for (const block of content) {
      if (typeof block === 'string') {
        textParts.push(block)
      } else if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_result') {
        toolResults.push(block as BetaToolResultBlockParam)
      } else if (block.type === 'image') {
        const imagePart = convertImageBlockToOpenAI(
          block as unknown as Record<string, unknown>,
        )
        if (imagePart) {
          imageParts.push(imagePart)
        }
      }
    }

    // CRITICAL: tool messages must come BEFORE any user message in the result.
    // OpenAI API requires that a tool message immediately follows the assistant
    // message with tool_calls. If we emit a user message first, the API will
    // reject the request with "insufficient tool messages following tool_calls".
    for (const tr of toolResults) {
      result.push(convertToolResult(tr))
    }

    // 如果有图片，构建多模态 content 数组
    if (imageParts.length > 0) {
      const multiContent: Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      > = []
      if (textParts.length > 0) {
        multiContent.push({ type: 'text', text: textParts.join('\n') })
      }
      multiContent.push(...imageParts)
      result.push({
        role: 'user',
        content: multiContent,
      } satisfies ChatCompletionUserMessageParam)
    } else if (textParts.length > 0) {
      result.push({
        role: 'user',
        content: textParts.join('\n'),
      } satisfies ChatCompletionUserMessageParam)
    }
  }

  return result
}

function convertToolResult(
  block: BetaToolResultBlockParam,
): ChatCompletionToolMessageParam {
  let content: string
  if (typeof block.content === 'string') {
    content = block.content
  } else if (Array.isArray(block.content)) {
    content = block.content
      .map(c => {
        if (typeof c === 'string') return c
        if ('text' in c) return c.text
        return ''
      })
      .filter(Boolean)
      .join('\n')
  } else {
    content = ''
  }

  return {
    role: 'tool',
    tool_call_id: block.tool_use_id,
    content,
  } satisfies ChatCompletionToolMessageParam
}

function convertInternalAssistantMessage(
  msg: AssistantMessage,
  options?: ConvertMessagesOptions,
): ChatCompletionMessageParam[] {
  const content = msg.message.content
  // Attached to every shape below, including the degenerate ones: a turn whose
  // text came back empty still produced reasoning that the next request has to
  // replay, and dropping it there would break the prefix just as thoroughly.
  const reasoningItems = options?.preserveReasoningItems
    ? readReasoningItems(msg.message as unknown as Record<string, unknown>)
    : []
  const withReasoning = <T extends ChatCompletionAssistantMessageParam>(
    message: T,
  ): T =>
    reasoningItems.length > 0
      ? { ...message, [OPENAI_REASONING_ITEMS_FIELD]: reasoningItems }
      : message

  if (typeof content === 'string') {
    return [
      withReasoning({
        role: 'assistant',
        content,
      } satisfies ChatCompletionAssistantMessageParam),
    ]
  }

  if (!Array.isArray(content)) {
    return [
      withReasoning({
        role: 'assistant',
        content: '',
      } satisfies ChatCompletionAssistantMessageParam),
    ]
  }

  const textParts: string[] = []
  const toolCalls: NonNullable<
    ChatCompletionAssistantMessageParam['tool_calls']
  > = []
  const reasoningParts: string[] = []

  for (const block of content) {
    if (typeof block === 'string') {
      textParts.push(block)
    } else if (block.type === 'text') {
      textParts.push(block.text)
    } else if (block.type === 'tool_use') {
      const tu = block as BetaToolUseBlock
      toolCalls.push({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments:
            typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input),
        },
      })
    } else if (block.type === 'thinking') {
      // DeepSeek thinking mode: always preserve reasoning_content,
      // including the empty-string case. DeepSeek v4 may return
      // reasoning_content: "" when the model answers directly, and the
      // empty value must be echoed back in the next request — otherwise
      // DeepSeek returns 400 ("reasoning_content ... must be passed back").
      const thinkingText = (block as unknown as Record<string, unknown>)
        .thinking
      if (typeof thinkingText === 'string') {
        reasoningParts.push(thinkingText)
      }
    }
    // Skip redacted_thinking, server_tool_use, etc.
  }

  const result: ChatCompletionAssistantMessageParam = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('\n') : null,
    ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    ...(reasoningParts.length > 0 && {
      reasoning_content: reasoningParts.join('\n'),
    }),
  }

  return [withReasoning(result)]
}

/**
 * 将 Anthropic image 块转换为 OpenAI image_url 格式。
 *
 * Anthropic 格式: { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } }
 * OpenAI 格式: { type: "image_url", image_url: { url: "data:image/png;base64,..." } }
 */
function convertImageBlockToOpenAI(
  block: Record<string, unknown>,
): { type: 'image_url'; image_url: { url: string } } | null {
  const source = block.source as Record<string, unknown> | undefined
  if (!source) return null

  if (source.type === 'base64' && typeof source.data === 'string') {
    const mediaType = (source.media_type as string) || 'image/png'
    return {
      type: 'image_url',
      image_url: {
        url: `data:${mediaType};base64,${source.data}`,
      },
    }
  }

  // url 类型的图片直接传递
  if (source.type === 'url' && typeof source.url === 'string') {
    return {
      type: 'image_url',
      image_url: {
        url: source.url,
      },
    }
  }

  return null
}
