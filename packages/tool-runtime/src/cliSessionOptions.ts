/**
 * Process-scoped CLI options that a handful of leaf consumers need but that
 * cannot ride on `ToolUseContext['options']`.
 *
 * Why a module-scoped store instead of the context bag: these three options
 * are print-mode only, and the print path builds its own context deep inside
 * `src/cli/print/`. Threading three fields through that plumbing buys nothing
 * — the values are set once from the Commander action and never vary within a
 * process, including inside subagents (upstream propagates them to nested
 * subagents for exactly that reason). Living in `tool-runtime` is what lets
 * `packages/builtin-tools/` read them without importing host `src/`.
 *
 * Everything defaults to "off", so a process that never calls the setters
 * behaves exactly as before.
 */

export type CliSessionOptions = {
  /**
   * `--forward-subagent-text`. When false (the default) subagent progress
   * carries only tool_use / tool_result blocks; when true, text and thinking
   * blocks are forwarded too, and nested subagent progress bubbles up.
   */
  forwardSubagentText: boolean
  /**
   * `--append-subagent-system-prompt`. Appended to every Task-tool subagent's
   * system prompt. Additionally gated by
   * `CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT`, matching upstream.
   */
  appendSubagentSystemPrompt: string | undefined
  /**
   * `--plan-mode-instructions`. Replaces the workflow body of the plan-mode
   * system reminder. The read-only preamble and the ExitPlanMode footer are
   * always kept.
   */
  planModeInstructions: string | undefined
}

const DEFAULTS: CliSessionOptions = {
  forwardSubagentText: false,
  appendSubagentSystemPrompt: undefined,
  planModeInstructions: undefined,
}

let state: CliSessionOptions = { ...DEFAULTS }

/** Called once from the Commander root action. */
export function setCliSessionOptions(next: Partial<CliSessionOptions>): void {
  state = { ...state, ...next }
}

export function resetCliSessionOptions(): void {
  state = { ...DEFAULTS }
}

export function getCliSessionOptions(): Readonly<CliSessionOptions> {
  return state
}

export function shouldForwardSubagentText(): boolean {
  return state.forwardSubagentText
}

/**
 * The subagent system-prompt addendum, or undefined when unset or when the
 * `CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT` gate is not on. The env gate is
 * upstream's, and the CLI flag implies it — but an SDK caller can set the
 * option without the env var, and upstream keeps it inert in that case.
 */
export function getAppendSubagentSystemPrompt(): string | undefined {
  if (!state.appendSubagentSystemPrompt) return undefined
  const gate = process.env.CLAUDE_CODE_ENABLE_APPEND_SUBAGENT_PROMPT
  if (!gate) return undefined
  const normalized = gate.toLowerCase().trim()
  if (!['1', 'true', 'yes', 'on'].includes(normalized)) return undefined
  return state.appendSubagentSystemPrompt
}

/** `--plan-mode-instructions`, or undefined when unset. */
export function getPlanModeInstructionsOverride(): string | undefined {
  return state.planModeInstructions || undefined
}
