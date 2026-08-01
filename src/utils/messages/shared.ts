/**
 * Internal helpers shared by several messages modules. Deliberately NOT
 * re-exported by the barrel — these are implementation details.
 */
import type {
  HookAttachment,
  HookPermissionDecisionAttachment,
} from '../attachments.js'
import type { AttachmentMessage, Message } from '../../types/message.js'

// Hook attachments that have a hookName field (excludes HookPermissionDecisionAttachment)
export type HookAttachmentWithName = Exclude<
  HookAttachment,
  HookPermissionDecisionAttachment
>

export function isHookAttachmentMessage(
  message: Message,
): message is AttachmentMessage<HookAttachment> {
  return (
    message.type === 'attachment' &&
    (message.attachment?.type === 'hook_blocking_error' ||
      message.attachment?.type === 'hook_cancelled' ||
      message.attachment?.type === 'hook_error_during_execution' ||
      message.attachment?.type === 'hook_non_blocking_error' ||
      message.attachment?.type === 'hook_success' ||
      message.attachment?.type === 'hook_system_message' ||
      message.attachment?.type === 'hook_additional_context' ||
      message.attachment?.type === 'hook_stopped_continuation')
  )
}
