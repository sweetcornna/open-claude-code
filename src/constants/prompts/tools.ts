import { BASH_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/PowerShellTool/toolName.js'
import { GLOB_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/GrepTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/TaskCreateTool/constants.js'
import { AGENT_TOOL_NAME } from '@open-claude-code/builtin-tools/tools/AgentTool/constants.js'
import { isForkSubagentEnabled } from '@open-claude-code/builtin-tools/tools/AgentTool/forkSubagent.js'
import { isReplModeEnabled } from '@open-claude-code/builtin-tools/tools/REPLTool/replMode.js'
import { bulletSection } from './format.js'

/**
 * Names enumerated in the "Using your tools" core-tools sentence, split around
 * the shell-tool slot (Bash/PowerShell varies by platform). Exported so the
 * guardrail runner can assert every name is a member of CORE_TOOLS — the two
 * previous hand-written copies of this list had drifted apart.
 */
export const CORE_TOOLS_PROMPT_LEADING_NAMES = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
] as const
// NOTE: the previous hand-written list also claimed CronCreate/CronDelete/
// CronList/Config/MCPTool were core — they are NOT in CORE_TOOLS (they are
// deferred tools reachable only via SearchExtraTools/ExecuteExtraTool). The
// guardrail runner's membership assertion now prevents that lie recurring.
export const CORE_TOOLS_PROMPT_TRAILING_NAMES = [
  'Agent',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'NotebookEdit',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TodoWrite',
  'Skill',
  'LSP',
] as const

export function getUsingYourToolsSection(enabledTools: Set<string>): string {
  const taskToolName = [TASK_CREATE_TOOL_NAME, TODO_WRITE_TOOL_NAME].find(n =>
    enabledTools.has(n),
  )

  // In REPL mode, Read/Write/Edit/Glob/Grep/Bash/Agent are hidden from direct
  // use (REPL_ONLY_TOOLS). The "prefer dedicated tools over Bash" guidance is
  // irrelevant — REPL's own prompt covers how to call them from scripts.
  if (isReplModeEnabled()) {
    return (
      bulletSection('Using your tools', [
        taskToolName
          ? `Break down and manage your work with the ${taskToolName} tool. Mark each task as completed as soon as you are done. Do not batch up multiple tasks before marking them as completed.`
          : null,
      ]) ?? ''
    )
  }

  const hasPowerShell = enabledTools.has(POWERSHELL_TOOL_NAME)
  const hasBash = enabledTools.has(BASH_TOOL_NAME)
  // The full "which dedicated tool replaces which shell command" teaching has
  // its single home in the shell tools' own descriptions (BashTool/PowerShell
  // prompt.ts) — do not re-enumerate examples here.
  const shellToolGuidance = hasPowerShell
    ? hasBash
      ? `On Windows, prefer the ${POWERSHELL_TOOL_NAME} tool for terminal operations (git, npm, docker, builds, tests, system commands). Use ${BASH_TOOL_NAME} only when the user asks for bash/Git Bash or a command is clearly bash-only. Prefer dedicated tools over shell equivalents.`
      : `Prefer dedicated tools over ${POWERSHELL_TOOL_NAME} equivalents. Reserve ${POWERSHELL_TOOL_NAME} for shell operations: package installs, test runners, build commands, git operations.`
    : `Prefer dedicated tools over ${BASH_TOOL_NAME} equivalents. Reserve ${BASH_TOOL_NAME} for shell operations: package installs, test runners, build commands, git operations.`

  // Single source for the enumerated names (was two hand-maintained copies
  // that had already drifted from each other). The guardrail runner asserts
  // every name here ∈ CORE_TOOLS.
  const coreToolNames = [
    ...CORE_TOOLS_PROMPT_LEADING_NAMES,
    ...(hasPowerShell
      ? [POWERSHELL_TOOL_NAME, ...(hasBash ? [BASH_TOOL_NAME] : [])]
      : [BASH_TOOL_NAME]),
    ...CORE_TOOLS_PROMPT_TRAILING_NAMES,
  ]

  return (
    bulletSection('Using your tools', [
      `Core tools (${coreToolNames.join(', ')}) can be called directly as needed. ${shellToolGuidance}`,
      `Search before saying unknown — when the user references a file, function, or module you have not seen, search with ${GREP_TOOL_NAME}/${GLOB_TOOL_NAME} first.`,
      taskToolName
        ? `Break down and manage your work with the ${taskToolName} tool. Mark each task as completed as soon as you are done.`
        : null,
      // Harness fact the model cannot infer: this loop accepts several tool_use
      // blocks per assistant turn. Both halves are load-bearing — the permission
      // is useless without the dependency constraint, and stating only the
      // constraint reads as a ban on parallelism.
      `You can call multiple tools in a single response. Make independent tool calls in parallel; when one call needs a value from another's result, run them sequentially instead.`,
    ]) ?? ''
  )
}

export function getAgentToolSection(): string {
  return isForkSubagentEnabled()
    ? `Calling ${AGENT_TOOL_NAME} without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context — so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** — execute directly; do not re-delegate.`
    : `Use the ${AGENT_TOOL_NAME} tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.`
}
