import { FORK_BOILERPLATE_TAG } from '../../constants/xml.js'
import type { Message as MessageType } from '../../types/message.js'

// Boilerplate carrier lives in a mixed user message ([tool_result..., text])
// that AgentTool/forkSubagent.buildForkedMessages emits as the fork child's
// first user turn. The text block wraps <FORK_BOILERPLATE_TAG>...</..> + the
// user prompt; tool_result siblings keep the parent's tool calls closed.
const FORK_BOILERPLATE_OPEN_TAG = `<${FORK_BOILERPLATE_TAG}>`

export function isForkBoilerplateTextBlock(block: {
  type: string
  text?: string
}): boolean {
  return (
    block.type === 'text' &&
    typeof block.text === 'string' &&
    block.text.includes(FORK_BOILERPLATE_OPEN_TAG)
  )
}

export function isForkBoilerplateMessage(message: MessageType): boolean {
  if (message.type !== 'user' || !Array.isArray(message.message?.content))
    return false
  return message.message.content.some(isForkBoilerplateTextBlock)
}
