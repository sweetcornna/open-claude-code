/**
 * System prompt — public surface.
 *
 * The prompt itself lives in `./prompts/`, one module per concern. This file
 * stays put so the ~16 import sites keep working; it must contain no logic.
 *
 * Where to add things:
 *   - a new prompt section        → its own module under ./prompts/
 *   - ordering / cache boundary   → ./prompts/assemble.ts
 *   - a string two sections share → ./prompts/shared.ts
 */

export { getSystemPrompt } from './prompts/assemble.js'
export { prependBullets } from './prompts/format.js'
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from './prompts/shared.js'
export { computeSimpleEnvInfo } from './prompts/environment.js'
export { getScratchpadInstructions } from './prompts/scratchpad.js'
export {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from './prompts/subagent.js'
export {
  CORE_TOOLS_PROMPT_LEADING_NAMES,
  CORE_TOOLS_PROMPT_TRAILING_NAMES,
} from './prompts/tools.js'
