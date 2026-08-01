/**
 * Fan-out of streamed API events into REPL state updates.
 */
import type { BetaToolUseBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ThinkingBlock } from '@anthropic-ai/sdk/resources/index.mjs'
import { feature } from 'bun:bundle'
import type { SpinnerMode } from '../../components/Spinner.js'
import { isConnectorTextBlock } from '../../types/connectorText.js'
import type {
  Message,
  RequestStartEvent,
  StreamEvent,
  TombstoneMessage,
  ToolUseSummaryMessage,
} from '../../types/message.js'

export type StreamingToolUse = {
  index: number
  contentBlock: BetaToolUseBlock
  unparsedToolInput: string
}

export type StreamingThinking = {
  thinking: string
  isStreaming: boolean
  streamingEndedAt?: number
}

/**
 * Handles messages from a stream, updating response length for deltas and appending completed messages
 */
export function handleMessageFromStream(
  message:
    | Message
    | TombstoneMessage
    | StreamEvent
    | RequestStartEvent
    | ToolUseSummaryMessage,
  onMessage: (message: Message) => void,
  onUpdateLength: (newContent: string) => void,
  onSetStreamMode: (mode: SpinnerMode) => void,
  onStreamingToolUses: (
    f: (streamingToolUse: StreamingToolUse[]) => StreamingToolUse[],
  ) => void,
  onTombstone?: (message: Message) => void,
  onStreamingThinking?: (
    f: (current: StreamingThinking | null) => StreamingThinking | null,
  ) => void,
  onApiMetrics?: (metrics: { ttftMs: number }) => void,
  onStreamingText?: (f: (current: string | null) => string | null) => void,
): void {
  if (
    message.type !== 'stream_event' &&
    message.type !== 'stream_request_start'
  ) {
    // Handle tombstone messages - remove the targeted message instead of adding
    if (message.type === 'tombstone') {
      onTombstone?.(message.message as unknown as Message)
      return
    }
    // Tool use summary messages are SDK-only, ignore them in stream handling
    if (message.type === 'tool_use_summary') {
      return
    }
    // Capture complete thinking blocks for real-time display in transcript mode
    if (message.type === 'assistant') {
      const assistMsg = message as Message
      const contentArr = Array.isArray(assistMsg.message?.content)
        ? assistMsg.message.content
        : []
      const thinkingBlock = contentArr.find(
        block => typeof block !== 'string' && block.type === 'thinking',
      )
      if (
        thinkingBlock &&
        typeof thinkingBlock !== 'string' &&
        thinkingBlock.type === 'thinking'
      ) {
        const tb = thinkingBlock as ThinkingBlock
        onStreamingThinking?.(() => ({
          thinking: tb.thinking,
          isStreaming: false,
          streamingEndedAt: Date.now(),
        }))
      }
    }
    // Clear streaming text NOW so the render can switch displayedMessages
    // from deferredMessages to messages in the same batch, making the
    // transition from streaming text → final message atomic (no gap, no duplication).
    onStreamingText?.(() => null)
    onMessage(message as Message)
    return
  }

  if (message.type === 'stream_request_start') {
    onSetStreamMode('requesting')
    return
  }

  // At this point, message is a stream event with an `event` property
  const streamMsg = message as {
    type: string
    event: {
      type: string
      content_block: {
        type: string
        id?: string
        name?: string
        input?: Record<string, unknown>
      }
      index: number
      delta: {
        type: string
        text: string
        partial_json: string
        thinking: string
      }
      [key: string]: unknown
    }
    ttftMs?: number
    [key: string]: unknown
  }

  if (streamMsg.event.type === 'message_start') {
    if (streamMsg.ttftMs != null) {
      onApiMetrics?.({ ttftMs: streamMsg.ttftMs })
    }
  }

  if (streamMsg.event.type === 'message_stop') {
    onSetStreamMode('tool-use')
    onStreamingToolUses(() => [])
    return
  }

  switch (streamMsg.event.type) {
    case 'content_block_start':
      onStreamingText?.(() => null)
      if (
        feature('CONNECTOR_TEXT') &&
        isConnectorTextBlock(streamMsg.event.content_block)
      ) {
        onSetStreamMode('responding')
        return
      }
      switch (streamMsg.event.content_block.type) {
        case 'thinking':
        case 'redacted_thinking':
          onSetStreamMode('thinking')
          return
        case 'text':
          onSetStreamMode('responding')
          return
        case 'tool_use': {
          onSetStreamMode('tool-input')
          const contentBlock = streamMsg.event.content_block as BetaToolUseBlock
          const index = streamMsg.event.index
          onStreamingToolUses(_ => [
            ..._,
            {
              index,
              contentBlock,
              unparsedToolInput: '',
            },
          ])
          return
        }
        case 'server_tool_use':
        case 'web_search_tool_result':
        case 'code_execution_tool_result':
        case 'mcp_tool_use':
        case 'mcp_tool_result':
        case 'container_upload':
        case 'web_fetch_tool_result':
        case 'bash_code_execution_tool_result':
        case 'text_editor_code_execution_tool_result':
        case 'tool_search_tool_result':
        case 'compaction':
          onSetStreamMode('tool-input')
          return
      }
      return
    case 'content_block_delta':
      switch (streamMsg.event.delta.type) {
        case 'text_delta': {
          const deltaText = streamMsg.event.delta.text
          onUpdateLength(deltaText)
          onStreamingText?.(text => (text ?? '') + deltaText)
          return
        }
        case 'input_json_delta': {
          const delta = streamMsg.event.delta.partial_json
          const index = streamMsg.event.index
          onUpdateLength(delta)
          onStreamingToolUses(_ => {
            const element = _.find(_ => _.index === index)
            if (!element) {
              return _
            }
            return [
              ..._.filter(_ => _ !== element),
              {
                ...element,
                unparsedToolInput: element.unparsedToolInput + delta,
              },
            ]
          })
          return
        }
        case 'thinking_delta':
          onUpdateLength(streamMsg.event.delta.thinking)
          return
        case 'signature_delta':
          // Signatures are cryptographic authentication strings, not model
          // output. Excluding them from onUpdateLength prevents them from
          // inflating the OTPS metric and the animated token counter.
          return
        default:
          return
      }
    case 'content_block_stop':
      return
    case 'message_delta':
      onSetStreamMode('responding')
      return
    default:
      onSetStreamMode('responding')
      return
  }
}
