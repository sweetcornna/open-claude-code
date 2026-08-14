/**
 * Strings that more than one section needs verbatim.
 *
 * Anything here is a rule with two audiences (main session and subagents, or
 * a section plus the cache machinery). Keeping one constant is what stops the
 * copies drifting — the emoji rule already diverged once into an absolute ban
 * in one place and a conditional allowance in the other.
 */

/**
 * Boundary marker separating static (cross-org cacheable) content from dynamic
 * content. Everything BEFORE this marker in the system prompt array can use
 * scope: 'global'. Everything AFTER contains user/session-specific content and
 * should not be cached.
 *
 * WARNING: Do not remove or reorder this marker without updating cache logic in:
 * - src/utils/api.ts (splitSysPromptPrefix)
 * - src/services/api/claude.ts (buildSystemPromptBlocks)
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

/** Shared between the communication section and the subagent notes. */
export const EMOJI_GUIDANCE =
  'Only use emojis if the user explicitly requests it.'

/** Same two audiences as EMOJI_GUIDANCE. */
export const NO_COLON_BEFORE_TOOL_CALLS =
  'Do not use a colon before tool calls — "Let me read the file:" should be "Let me read the file." with a period.'

export const SUMMARIZE_TOOL_RESULTS_SECTION = `When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`
