import { isLocalAgentTask } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { FORK_SUBAGENT_TYPE } from '@open-claude-code/builtin-tools/tools/AgentTool/forkSubagent.js'
import { createUserMessage } from '../../utils/messages.js'
import { isForkBoilerplateTextBlock } from './forkBoilerplate.js'
import type { Message as MessageType } from '../../types/message.js'
import type { InProcessTeammateTaskState } from '../../tasks/InProcessTeammateTask/types.js'
import type { LocalAgentTaskState } from '../../tasks/LocalAgentTask/LocalAgentTask.js'

/**
 * Body of REPL's `displayedAgentMessages` useMemo, moved out verbatim as a pure
 * function. The useMemo itself (and its `[viewedAgentTask, rawAgentMessages]`
 * dep array) stays in REPL.tsx, so the hook call order is untouched.
 */
export function computeDisplayedAgentMessages(
  viewedAgentTask: InProcessTeammateTaskState | LocalAgentTaskState | undefined,
  rawAgentMessages: MessageType[] | undefined,
): MessageType[] | undefined {
  if (!viewedAgentTask) return undefined
  const agentMessages = rawAgentMessages ?? []
  if (
    !isLocalAgentTask(viewedAgentTask) ||
    viewedAgentTask.agentType !== FORK_SUBAGENT_TYPE ||
    !viewedAgentTask.prompt
  ) {
    return agentMessages
  }
  // Single pass: locate boilerplate carrier, check whether the prompt text is
  // already present elsewhere, and find the fallback insertion point (after
  // the last parent assistant tool_use).
  const trimmedPrompt = viewedAgentTask.prompt.trim()
  let boilerplateIndex = -1
  let lastAssistantToolUseIndex = -1
  let promptAlreadyRendered = false
  for (let i = 0; i < agentMessages.length; i++) {
    const m = agentMessages[i]!
    if (m.type === 'user' && Array.isArray(m.message?.content)) {
      const hasBoilerplate = m.message.content.some(isForkBoilerplateTextBlock)
      if (hasBoilerplate) {
        boilerplateIndex = i
      } else if (!promptAlreadyRendered) {
        const firstText = m.message.content.find(
          b => b.type === 'text' && typeof b.text === 'string',
        ) as { type: 'text'; text: string } | undefined
        if (firstText && firstText.text.trim() === trimmedPrompt)
          promptAlreadyRendered = true
      }
      continue
    }
    if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
      if (m.message.content.some(b => b.type === 'tool_use'))
        lastAssistantToolUseIndex = i
    }
  }

  const stripped =
    boilerplateIndex === -1
      ? agentMessages
      : agentMessages.map((m, i) => {
          if (i !== boilerplateIndex) return m
          if (!Array.isArray(m.message?.content)) return m
          return {
            ...m,
            message: {
              ...m.message,
              content: m.message.content.filter(
                b => !isForkBoilerplateTextBlock(b),
              ),
            },
          }
        })

  if (promptAlreadyRendered) return stripped

  const insertAt =
    boilerplateIndex !== -1
      ? boilerplateIndex + 1
      : lastAssistantToolUseIndex + 1
  const synthetic = createUserMessage({
    content: viewedAgentTask.prompt,
    timestamp: new Date(viewedAgentTask.startTime).toISOString(),
  })
  return [
    ...stripped.slice(0, insertAt),
    synthetic,
    ...stripped.slice(insertAt),
  ]
}
