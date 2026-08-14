import type { Attachment } from 'src/utils/attachments.js'
import type { Message, NormalizedMessage } from '../../types/message.js'

/**
 * Attachment types that AttachmentMessage renders as `null` unconditionally
 * (no visible output regardless of runtime state). Messages.tsx filters these
 * out BEFORE the render cap / message count so invisible entries don't consume
 * the 200-message render budget (CC-724).
 *
 * Sync is enforced by TypeScript: AttachmentMessage's switch `default:` branch
 * asserts `attachment.type satisfies NullRenderingAttachmentType`. Adding a new
 * Attachment type without either a case or an entry here will fail typecheck.
 */
const NULL_RENDERING_TYPES = [
  'hook_success',
  'hook_additional_context',
  'hook_cancelled',
  'command_permissions',
  'agent_mention',
  'budget_usd',
  'critical_system_reminder',
  'edited_image_file',
  'edited_text_file',
  'opened_file_in_ide',
  'output_style',
  'plan_mode',
  'ultracode_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'structured_output',
  'team_context',
  'todo_reminder',
  'context_efficiency',
  // Model-facing only: the Read tool's own result row already shows the line
  // count, so a second visible line would just be noise.
  'read_truncation_notice',
  'deferred_tools_delta',
  'tool_search_usage_reminder',
  'mcp_instructions_delta',
  'token_usage',
  'ultrathink_effort',
  // NOT here on purpose: 'max_turns_reached' is the harness cutting the turn
  // short, not a model-facing reminder. Rendering it as null is what makes a
  // maxTurns stop indistinguishable from "the model decided it was done" —
  // see AttachmentMessage's case for it.
  'task_reminder',
  'auto_mode',
  'auto_mode_exit',
  'output_token_usage',
  'verify_plan_reminder',
  'current_session_memory',
  'compaction_reminder',
  'date_change',
] as const satisfies readonly Attachment['type'][]

export type NullRenderingAttachmentType = (typeof NULL_RENDERING_TYPES)[number]

const NULL_RENDERING_ATTACHMENT_TYPES: ReadonlySet<Attachment['type']> =
  new Set(NULL_RENDERING_TYPES)

/**
 * True when this message is an attachment that AttachmentMessage renders as
 * null with no visible output. Messages.tsx filters these out before counting
 * and before applying the 200-message render cap, so invisible hook
 * attachments (hook_success, hook_additional_context, hook_cancelled) don't
 * inflate the "N messages" count or eat into the render budget (CC-724).
 */
export function isNullRenderingAttachment(
  msg: Message | NormalizedMessage,
): boolean {
  return (
    msg.type === 'attachment' &&
    NULL_RENDERING_ATTACHMENT_TYPES.has(
      msg.attachment!.type as Attachment['type'],
    )
  )
}
