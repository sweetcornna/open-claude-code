import { type LogOption } from '../../types/logs.js'
import type { AssistantMessage } from '../../types/message.js'
import { getTranscriptPath } from './paths.js'
import { loadTranscriptFile } from './transcriptLoader.js'
import { loadMessageLogs } from './sessionListing.js'

/**
 * Gets a log by its index
 * @param index Index in the sorted list of logs (0-based)
 * @returns Log data or null if not found
 */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * Looks up unresolved tool uses in the transcript by tool_use_id.
 * Returns the assistant message containing the tool_use, or null if not found
 * or the tool call already has a tool_result.
 */
export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    // Find the tool use but make sure there's not also a result
    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message!.content
        if (Array.isArray(content)) {
          for (const block of content as Array<{ type: string; id: string }>) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message!.content
        if (Array.isArray(content)) {
          for (const block of content as Array<{
            type: string
            tool_use_id: string
          }>) {
            if (
              block.type === 'tool_result' &&
              block.tool_use_id === toolUseId
            ) {
              // Found tool result, bail out
              return null
            }
          }
        }
      }
    }

    return toolUseMessage as AssistantMessage | null
  } catch {
    return null
  }
}
