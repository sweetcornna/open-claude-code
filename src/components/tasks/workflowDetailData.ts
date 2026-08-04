// Data projection + key routing behind WorkflowDetailDialog.tsx.
//
// React-free for the same reason as workflowTaskSummaryData: the windowing and
// key-routing logic is the part worth testing, and a unit test that never
// touches ink is immune to the process-global `mock.module` pollution that
// makes any late-ordered ink render in this suite hang.

import type { AgentProgress } from '../../workflow/progress/store.js'

/**
 * Max agent rows rendered at once in the detail dialog. The Shift+Down dialog
 * is a single-column overlay (unlike the two-column /workflows panel), so a
 * large fan-out workflow must window its agent list or the dialog outgrows
 * the terminal.
 */
export const MAX_VISIBLE_AGENTS = 10

/** Clamp a selection index into [0, len). Mirrors WorkflowsPanel.clampSelected without importing the panel component. */
export function clampAgentIndex(selected: number, len: number): number {
  if (len === 0) return 0
  const n = Math.trunc(selected)
  if (Number.isNaN(n) || n < 0) return 0
  return Math.min(n, len - 1)
}

export type AgentWindow = {
  /** The slice of agents to render. */
  visible: AgentProgress[]
  /** Selection index re-based into `visible`. */
  selectedInWindow: number
  /** Rows folded above the window (rendered as `… N earlier`). */
  hiddenAbove: number
  /** Rows folded below the window (rendered as `… N more`). */
  hiddenBelow: number
}

/**
 * Sliding window over the agent list, kept centered on the selection and
 * clamped to the list bounds. `selected` is assumed pre-clamped via
 * {@link clampAgentIndex}; maxVisible < 1 degenerates to a single row.
 */
export function windowAgents(
  agents: AgentProgress[],
  selected: number,
  maxVisible: number = MAX_VISIBLE_AGENTS,
): AgentWindow {
  const cap = Math.max(1, Math.trunc(maxVisible))
  if (agents.length <= cap) {
    return {
      visible: agents,
      selectedInWindow: selected,
      hiddenAbove: 0,
      hiddenBelow: 0,
    }
  }
  const half = Math.floor(cap / 2)
  const start = Math.min(Math.max(0, selected - half), agents.length - cap)
  return {
    visible: agents.slice(start, start + cap),
    selectedInWindow: selected - start,
    hiddenAbove: start,
    hiddenBelow: agents.length - (start + cap),
  }
}

export type WorkflowDetailKeyAction =
  | 'moveUp'
  | 'moveDown'
  | 'openAgent'
  | 'killWorkflow'
  | 'back'
  | 'confirmYes'
  | 'confirmNo'

/**
 * Raw-key router for the detail dialog's onKeyDown handler. `key` follows the
 * ink KeyboardEvent convention: literal char for printables ('K'), multi-char
 * name for special keys ('up', 'return', 'escape').
 *
 * x (kill selected agent) is deliberately absent: it flows through the
 * configurable `taskDetail:kill` keybinding like every other detail dialog.
 * Capital K = kill the whole workflow, matching the /workflows panel (Shift
 * hints at the heavier operation).
 *
 * Enter/→ drill into the selected agent and ← steps back out one level, the
 * same gesture as the /workflows panel — the two surfaces render the same
 * run, so their navigation must not disagree. `back` stays on ← only:
 * closing the dialog is Esc's job.
 *
 * In confirm mode only y/n/Enter/Esc respond; everything else returns null so
 * a stray navigation key can't move the selection under an open confirmation.
 */
export function routeWorkflowDetailKey(
  key: string,
  mode: 'normal' | 'confirm',
): WorkflowDetailKeyAction | null {
  if (mode === 'confirm') {
    if (key === 'y' || key === 'Y' || key === 'return') return 'confirmYes'
    if (key === 'n' || key === 'N' || key === 'escape') return 'confirmNo'
    return null
  }
  if (key === 'up') return 'moveUp'
  if (key === 'down') return 'moveDown'
  if (key === 'return' || key === 'right') return 'openAgent'
  if (key === 'K') return 'killWorkflow'
  if (key === 'left') return 'back'
  return null
}
