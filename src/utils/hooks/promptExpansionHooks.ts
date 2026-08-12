/**
 * UserPromptExpansion hook executor (official 2.1.228 parity).
 *
 * Kept out of lifecycleHooks.ts on purpose: the only caller is
 * `processUserInput/processSlashCommand.tsx`, and a static edge from there into
 * lifecycleHooks.ts (which reaches compaction, session storage and elicitation)
 * closes 17 new import cycles. The two-sided ratchet in scripts/check-cycles.ts
 * makes that a hard failure, so this executor lives in its own leaf that only
 * needs ./config.js and ./execution.js.
 */

import { randomUUID } from 'crypto'
import { getSessionId } from '../../bootstrap/state.js'
import type { UserPromptExpansionHookInput } from 'src/entrypoints/agentSdkTypes.js'
import type { ToolUseContext } from '../../Tool.js'
import { createBaseHookInput, hasHookForEvent } from './config.js'
import {
  type AggregatedHookResult,
  executeHooks,
  TOOL_HOOK_EXECUTION_TIMEOUT_MS,
} from './execution.js'

/**
 * Execute UserPromptExpansion hooks when a user-typed slash command (or MCP
 * prompt) is about to expand into a prompt.
 *
 * Output semantics — deliberately NOT a rewrite hook:
 *  - `hookSpecificOutput.additionalContext` is *appended* alongside the
 *    expansion; it never replaces the expanded prompt.
 *  - blocking (exit code 2 / decision "block") aborts the expansion.
 *  - `continue: false` stops the turn.
 *
 * Matchers match on `command_name`.
 *
 * @param expansionType Whether a slash command or an MCP prompt is expanding
 * @param commandName Command name without the leading slash
 * @param commandArgs Raw argument string (empty when the user typed none)
 * @param commandSource Where the command was loaded from (settings, plugin, mcp…)
 * @param prompt The literal text the user typed, e.g. `/review HEAD~1`
 * @param permissionMode Permission mode from toolPermissionContext
 * @param toolUseContext ToolUseContext for prompt-based hooks and agent scoping
 * @returns Async generator that yields progress messages and hook results
 */
export async function* executeUserPromptExpansionHooks(
  expansionType: 'slash_command' | 'mcp_prompt',
  commandName: string,
  commandArgs: string,
  commandSource: string | undefined,
  prompt: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptExpansion', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptExpansionHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptExpansion',
    expansion_type: expansionType,
    command_name: commandName,
    command_args: commandArgs,
    command_source: commandSource,
    prompt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
  })
}
