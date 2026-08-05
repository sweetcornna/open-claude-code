import type { AgentProgress, RunProgress } from '../progress/store.js'

/** run status -> dot character (used by top tab). */
export const STATUS_DOT: Record<RunProgress['status'], string> = {
  running: '●',
  completed: '✓',
  failed: '✗',
  killed: '■',
}

/** run status -> ink theme color token (follows existing WorkflowList palette). */
export const RUN_STATUS_COLOR: Record<RunProgress['status'], string> = {
  running: 'warning',
  completed: 'success',
  failed: 'error',
  killed: 'subtle',
}

/** run status -> display text (used by header; aligns with reference image done/running). */
export const RUN_STATUS_TEXT: Record<RunProgress['status'], string> = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  killed: 'killed',
}

/** merged phase status in the sidebar (includes pending: declared by meta but not started). */
export type PhaseStatus = 'running' | 'done' | 'pending'

export const PHASE_MARK: Record<PhaseStatus, string> = {
  running: '●',
  done: '✓',
  pending: '○',
}

export const PHASE_COLOR: Record<PhaseStatus, string> = {
  running: 'warning',
  done: 'success',
  pending: 'subtle',
}

/** visual for an agent row: mark character + color (running has the mark overridden by a spinner animation in UI). */
export type AgentVisual = { mark: string; color: string }

/**
 * The exact failureReason values run_done stamps on agents it reaps (store.ts).
 *
 * An explicit set rather than a `run-` prefix test: the engine's own vocabulary already
 * contains `runagent-threw`, one character away from matching, and a real crash quietly
 * reclassified as "the user stopped it" is the worst possible direction for this bug to
 * fail in. Adding a reap reason to the store means adding it here.
 */
const RUN_REAPED_REASONS = new Set(['run-killed', 'run-failed', 'run-ended'])

/**
 * True for an agent the store reaped because the *run* reached a terminal state while
 * the agent was still going.
 *
 * It is stored as resultKind 'dead' — no result was ever produced — but it did not die
 * on its own merits, so it must not be reported as a failure: the common case is the
 * user pressing K, and being told their own kill "failed" is both wrong and alarming.
 */
export function isRunReaped(a: AgentProgress): boolean {
  return (
    a.resultKind === 'dead' &&
    a.failureReason !== undefined &&
    RUN_REAPED_REASONS.has(a.failureReason)
  )
}

/**
 * True while the engine is parked in a retry backoff for this agent.
 *
 * The store never clears `retryingSince` — the engine only announces the *start* of a
 * backoff (agent_retry), never its end — so "still waiting" has to be derived from the
 * wall clock. Shared by the list row's ↻ marker and the detail pane's status copy so
 * the two can never disagree about whether anything is happening.
 */
export function isRetryBackoffActive(a: AgentProgress, now: number): boolean {
  if (a.status !== 'running' || a.retryingSince === undefined) return false
  return now < a.retryingSince + (a.retryDelayMs ?? 0)
}

/**
 * agent status -> visual.
 * - running -> ● warning (UI overrides mark with spinner animation)
 * - done·dead reaped with the run -> ⊘ subtle (see isRunReaped)
 * - done·dead -> ✗ error
 * - done·skipped -> ⊘ subtle (user skipped; showing ✓ would misread as success)
 * - done·ok -> ✓ success
 */
export function agentVisual(a: AgentProgress): AgentVisual {
  if (a.status === 'running') return { mark: '●', color: 'warning' }
  if (isRunReaped(a)) return { mark: '⊘', color: 'subtle' }
  if (a.resultKind === 'dead') return { mark: '✗', color: 'error' }
  if (a.resultKind === 'skipped') return { mark: '⊘', color: 'subtle' }
  return { mark: '✓', color: 'success' }
}

/** token count -> display string (<1000 keeps the raw value; otherwise keeps 1 decimal + k). */
export function formatTokenCount(n: number | undefined): string {
  if (!n) return '0'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/**
 * Strip the vendor prefix and trailing date stamp from a model id so the
 * agent row spends its width on the label instead of on
 * `us.anthropic.claude-sonnet-5-20260101`. Unrecognized ids pass through.
 */
export function shortModelName(model: string): string {
  let s = model.trim()
  // Bedrock/Vertex region + vendor prefixes, e.g. `us.anthropic.claude-…`.
  s = s.replace(/^[a-z]{2,3}\.anthropic\./, '')
  s = s.replace(/^anthropic\./, '')
  s = s.replace(/^claude-/, '')
  // Trailing release stamp: `-20251001`, and the `[1m]` context suffix.
  s = s.replace(/-\d{8}(?=$|\[)/, '')
  return s || model
}

/**
 * right-side stats text for an agent row: `model · Nk tok`.
 *
 * The per-row tool count moved into the agent detail view: at list width it
 * pushed the label column down to a stub, and the number is only actionable
 * once you are already looking at one agent.
 */
export function agentMetaText(a: AgentProgress): string {
  const parts: string[] = []
  if (a.model) parts.push(shortModelName(a.model))
  parts.push(`${formatTokenCount(a.tokenCount)} tok`)
  return parts.join(' · ')
}

/**
 * Human label for an agent's terminal state, used by the detail view header.
 * Running agents report as `running`; `done` splits by resultKind so a dead
 * or skipped agent is never described as a success.
 */
export function agentStatusText(a: AgentProgress): string {
  if (a.status === 'running') return 'running'
  if (isRunReaped(a)) return 'stopped'
  if (a.resultKind === 'dead') return 'failed'
  if (a.resultKind === 'skipped') return 'skipped'
  return 'done'
}
