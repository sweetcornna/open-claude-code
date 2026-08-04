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
 * agent status -> visual.
 * - running -> ● warning (UI overrides mark with spinner animation)
 * - done·dead -> ✗ error
 * - done·skipped -> ⊘ subtle (user skipped; showing ✓ would misread as success)
 * - done·ok -> ✓ success
 */
export function agentVisual(a: AgentProgress): AgentVisual {
  if (a.status === 'running') return { mark: '●', color: 'warning' }
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
  if (a.resultKind === 'dead') return 'failed'
  if (a.resultKind === 'skipped') return 'skipped'
  return 'done'
}
