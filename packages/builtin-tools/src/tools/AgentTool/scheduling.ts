/**
 * Where the Agent tool decides foreground vs background.
 *
 * Extracted from `AgentTool.call()` so the decision can be unit-tested
 * without dragging in the tool's module graph, and so the three places that
 * ask the question (two telemetry payloads and the scheduler itself) cannot
 * drift apart again — they used to be three hand-copied boolean expressions.
 *
 * Default changed 2026-08-13 (user-approved alignment with upstream): an
 * omitted `run_in_background` now means BACKGROUND. `false` is the only way
 * to request the foreground. The tool's parameter description and
 * `prompt.ts` state the same thing; all three move together or the model is
 * told its agents are detached while they hold the main loop open.
 */

export type AgentSchedulingInput = {
  /** The `run_in_background` parameter as the model supplied it. */
  runInBackground: boolean | undefined
  /** `background: true` in the agent definition's frontmatter. */
  agentDefinitionBackground: boolean | undefined
  /**
   * In-process teammates share the terminal and are refused outright when
   * they ask for background, so they stay foreground-by-default.
   */
  isInProcessTeammate: boolean
}

/**
 * Whether this spawn asks for the background, ignoring the session-level
 * forcing switches. This is the value the `is_async` telemetry fields report.
 */
export function isBackgroundRequested(input: AgentSchedulingInput): boolean {
  if (input.runInBackground === true) return true
  if (input.agentDefinitionBackground === true) return true
  if (input.isInProcessTeammate) return false
  return input.runInBackground !== false
}

/**
 * The actual scheduling decision.
 *
 * `isBackgroundTasksDisabled` is an unconditional veto — with background
 * tasks off there is nowhere for the agent to run but the foreground, no
 * matter who asked or how hard.
 */
export function shouldAgentRunAsync(
  input: AgentSchedulingInput & {
    /**
     * Session-level forcing: coordinator mode, the fork-subagent experiment,
     * assistant/Kairos mode, or proactive mode. Any of these makes every
     * spawn async regardless of the parameter.
     */
    forcedAsync: boolean
    isBackgroundTasksDisabled: boolean
  },
): boolean {
  if (input.isBackgroundTasksDisabled) return false
  return isBackgroundRequested(input) || input.forcedAsync
}
