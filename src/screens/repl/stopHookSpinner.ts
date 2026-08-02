import { count } from '../../utils/collections/array.js'
import { truncateToWidth } from '../../utils/format.js'
import type {
  Message as MessageType,
  ProgressMessage,
} from '../../types/message.js'
import type { HookProgress } from '../../types/hooks.js'

/**
 * Body of REPL's `stopHookSpinnerSuffix` useMemo, moved out verbatim as a pure
 * function. The useMemo itself (and its `[messages, isLoading]` dep array)
 * stays in REPL.tsx, so the hook call order is untouched.
 */
export function computeStopHookSpinnerSuffix(
  messages: MessageType[],
  isLoading: boolean,
): string | null {
  if (!isLoading) return null

  // Find stop hook progress messages
  const progressMsgs = messages.filter(
    (m): m is ProgressMessage<HookProgress> => {
      if (m.type !== 'progress') return false
      const data = m.data as Record<string, unknown>
      return (
        data.type === 'hook_progress' &&
        (data.hookEvent === 'Stop' || data.hookEvent === 'SubagentStop')
      )
    },
  )
  if (progressMsgs.length === 0) return null

  // Get the most recent stop hook execution
  const currentToolUseID = progressMsgs.at(-1)?.toolUseID
  if (!currentToolUseID) return null

  // Check if there's already a summary message for this execution (hooks completed)
  const hasSummaryForCurrentExecution = messages.some(
    m =>
      m.type === 'system' &&
      m.subtype === 'stop_hook_summary' &&
      m.toolUseID === currentToolUseID,
  )
  if (hasSummaryForCurrentExecution) return null

  const currentHooks = progressMsgs.filter(
    p => p.toolUseID === currentToolUseID,
  )
  const total = currentHooks.length

  // Count completed hooks
  const completedCount = count(messages, m => {
    if (m.type !== 'attachment') return false
    const attachment = m.attachment!
    return (
      'hookEvent' in attachment &&
      (attachment.hookEvent === 'Stop' ||
        attachment.hookEvent === 'SubagentStop') &&
      'toolUseID' in attachment &&
      attachment.toolUseID === currentToolUseID
    )
  })

  // Check if any hook has a custom status message
  const customMessage = currentHooks.find(p => p.data.statusMessage)?.data
    .statusMessage

  if (customMessage) {
    // Use custom message with progress counter if multiple hooks
    return total === 1
      ? `${customMessage}…`
      : `${customMessage}… ${completedCount}/${total}`
  }

  // Fall back to default behavior
  const hookType =
    currentHooks[0]?.data.hookEvent === 'SubagentStop'
      ? 'subagent stop'
      : 'stop'

  if (process.env.USER_TYPE === 'ant') {
    const cmd = currentHooks[completedCount]?.data.command
    const label = cmd ? ` '${truncateToWidth(cmd, 40)}'` : ''
    return total === 1
      ? `running ${hookType} hook${label}`
      : `running ${hookType} hook${label}\u2026 ${completedCount}/${total}`
  }

  return total === 1
    ? `running ${hookType} hook`
    : `running stop hooks… ${completedCount}/${total}`
}
