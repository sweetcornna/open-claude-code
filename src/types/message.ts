// Auto-generated stub — replace with real implementation
import type { UUID } from 'crypto'

/**
 * Base message type with discriminant `type` field and common properties.
 * Individual message subtypes (UserMessage, AssistantMessage, etc.) extend
 * this with narrower `type` literals and additional fields.
 */
export type MessageType = 'user' | 'assistant' | 'system' | 'attachment' | 'progress'
export type Message = {
  type: MessageType
  uuid: UUID
  isMeta?: boolean
  isCompactSummary?: boolean
  toolUseResult?: unknown
  isVisibleInTranscriptOnly?: boolean
  attachment?: { type: string; toolUseID?: string; [key: string]: unknown }
  message?: {
    role?: string
    id?: string
    content?: string | Array<{ type: string; text?: string; id?: string; name?: string; tool_use_id?: string; [key: string]: unknown }>
    usage?: Record<string, unknown>
    [key: string]: unknown
  }
  [key: string]: unknown
}
export type AssistantMessage = Message & { type: 'assistant' };
export type AttachmentMessage<T = unknown> = Message & { type: 'attachment'; attachment: { type: string; [key: string]: unknown } };
export type ProgressMessage<T = unknown> = Message & { type: 'progress'; data: T };
export type SystemLocalCommandMessage = Message & { type: 'system' };
export type SystemMessage = Message & { type: 'system' };
export type UserMessage = Message & { type: 'user' };
export type NormalizedUserMessage = UserMessage;
export type RequestStartEvent = { type: string; [key: string]: unknown };
export type StreamEvent = { type: string; [key: string]: unknown };
export type SystemCompactBoundaryMessage = Message & {
  type: 'system'
  compactMetadata: {
    preservedSegment?: {
      headUuid: UUID
      tailUuid: UUID
      anchorUuid: UUID
      [key: string]: unknown
    }
    [key: string]: unknown
  }
};
export type TombstoneMessage = Message;
export type ToolUseSummaryMessage = Message;
export type MessageOrigin = string;
export type CompactMetadata = Record<string, unknown>;
export type SystemAPIErrorMessage = Message & { type: 'system' };
export type SystemFileSnapshotMessage = Message & { type: 'system' };
export type NormalizedAssistantMessage<T = unknown> = AssistantMessage;
export type NormalizedMessage = Message;
export type PartialCompactDirection = string;
export type StopHookInfo = Record<string, unknown>;
export type SystemAgentsKilledMessage = Message & { type: 'system' };
export type SystemApiMetricsMessage = Message & { type: 'system' };
export type SystemAwaySummaryMessage = Message & { type: 'system' };
export type SystemBridgeStatusMessage = Message & { type: 'system' };
export type SystemInformationalMessage = Message & { type: 'system' };
export type SystemMemorySavedMessage = Message & { type: 'system' };
export type SystemMessageLevel = string;
export type SystemMicrocompactBoundaryMessage = Message & { type: 'system' };
export type SystemPermissionRetryMessage = Message & { type: 'system' };
export type SystemScheduledTaskFireMessage = Message & { type: 'system' };
export type SystemStopHookSummaryMessage = Message & { type: 'system' };
export type SystemTurnDurationMessage = Message & { type: 'system' };
export type GroupedToolUseMessage = Message;
export type RenderableMessage = Message;
export type CollapsedReadSearchGroup = Message;
export type CollapsibleMessage = Message;
export type HookResultMessage = Message;
export type SystemThinkingMessage = Message & { type: 'system' };
