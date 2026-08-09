import type { AgentProgress, RunProgress } from '../progress/store.js'
import type { PhaseStatus } from './status.js'

/** Title of the fixed "no filter" item (first row of the sidebar). */
export const ALL_PHASE = 'All'

/** Merged phase (including pending), with done/total counts of agents under that phase. */
export type MergedPhase = {
  title: string
  status: PhaseStatus
  done: number
  total: number
}

/**
 * Derive a phase's sidebar status from the actual record + the agents grouped under it.
 *
 * The actual record comes from `phase_started`/`phase_done` events. Scripts that follow the
 * ultracode canonical pipeline pattern pass `opts.phase` directly to `agent()` inside
 * `pipeline()`/`parallel()` stages and never call `phase()` for those phases — so no
 * `phase_started` ever fires and `run.phases` lacks them. Worse, because `phase_done` only
 * emits when the *next* `phase()` runs, the previous phase stays "running" in `run.phases`
 * even after all its agents finish.
 *
 * Rules (checked in order):
 * 1. `phase_done` already fired → done is authoritative, respect it.
 * 2. Agents exist under this phase → derive from their states
 *    (all done → done; otherwise → running). This is what the user actually sees.
 * 3. No agents yet → fall back to the actual record
 *    (`running` if `phase()` was called and is still active, else pending).
 */
function derivePhaseStatus(
  actual: { status: 'running' | 'done' } | undefined,
  inPhase: AgentProgress[],
): PhaseStatus {
  if (actual?.status === 'done') return 'done'
  if (inPhase.length > 0) {
    return inPhase.every(a => a.status === 'done') ? 'done' : 'running'
  }
  return actual?.status === 'running' ? 'running' : 'pending'
}

/**
 * Merge declaredPhases (declared by meta), run.phases (actually running/done),
 * and phases that appear only on agents:
 * - Declared order takes priority; then actual-but-undeclared; then agent-only phases.
 *   Agent-only phases surface in the sidebar even when the script never called `phase()`
 *   for them — otherwise the user sees agents running under a phase that isn't listed.
 * - Status is derived via {@link derivePhaseStatus}.
 * - done/total = done under that phase / total agents under that phase.
 */
export function mergePhases(
  run: Pick<RunProgress, 'declaredPhases' | 'phases' | 'agents'>,
): MergedPhase[] {
  const actualByTitle = new Map(run.phases.map(p => [p.title, p]))
  const seen = new Set<string>()
  const out: MergedPhase[] = []
  const push = (title: string): void => {
    if (seen.has(title)) return
    seen.add(title)
    const actual = actualByTitle.get(title)
    const inPhase = run.agents.filter(a => a.phase === title)
    out.push({
      title,
      status: derivePhaseStatus(actual, inPhase),
      done: inPhase.filter(a => a.status === 'done').length,
      total: inPhase.length,
    })
  }
  for (const t of run.declaredPhases) push(t)
  for (const p of run.phases) push(p.title)
  // Scripts that pass opts.phase directly to agent() (the ultracode pipeline pattern)
  // may have agents grouped under phases that never got a phase() call — surface them
  // so the sidebar reflects every phase the user can actually observe agents running in.
  for (const a of run.agents) {
    if (a.phase) push(a.phase)
  }
  return out
}

/**
 * Filter agents by the selected phase.
 * selectedPhase undefined or ALL_PHASE -> all.
 */
export function filterAgentsByPhase(
  agents: AgentProgress[],
  selectedPhase: string | undefined,
): AgentProgress[] {
  if (selectedPhase === undefined || selectedPhase === ALL_PHASE) return agents
  return agents.filter(a => a.phase === selectedPhase)
}

/**
 * Agent-list status filter (cycled with `f`). `failed` covers dead agents
 * only — a skipped agent is neither a failure nor a success, so it shows up
 * under `all` and nowhere else.
 */
export type AgentStatusFilter = 'all' | 'running' | 'done' | 'failed'

/** Cycle order for `f`. Wraps back to 'all'. */
export const AGENT_STATUS_FILTERS: readonly AgentStatusFilter[] = [
  'all',
  'running',
  'done',
  'failed',
]

export function nextAgentStatusFilter(
  current: AgentStatusFilter,
): AgentStatusFilter {
  const i = AGENT_STATUS_FILTERS.indexOf(current)
  return AGENT_STATUS_FILTERS[(i + 1) % AGENT_STATUS_FILTERS.length]!
}

/**
 * Filter agents by run status. Applied after {@link filterAgentsByPhase} so
 * the phase sidebar's counts stay whole-phase totals while the list narrows.
 */
export function filterAgentsByStatus(
  agents: AgentProgress[],
  filter: AgentStatusFilter,
): AgentProgress[] {
  switch (filter) {
    case 'running':
      return agents.filter(a => a.status === 'running')
    case 'done':
      return agents.filter(a => a.status === 'done' && a.resultKind !== 'dead')
    case 'failed':
      return agents.filter(a => a.resultKind === 'dead')
    default:
      return agents
  }
}

/**
 * Elapsed milliseconds for an agent: settled span once done, live span while
 * running. Returns null when the agent predates timestamp capture (runs
 * persisted before startedAt existed) so the UI can render a placeholder
 * instead of a bogus multi-decade duration measured from epoch 0.
 */
export function agentElapsedMs(
  a: Pick<AgentProgress, 'startedAt' | 'endedAt'>,
  now: number,
): number | null {
  if (a.startedAt === undefined) return null
  return Math.max(0, (a.endedAt ?? now) - a.startedAt)
}

/**
 * Keep only runs still in flight. The /workflows panel defaults to this view: opening the panel
 * no longer floods the tab row with months of persisted historical runs (which overflowed the
 * terminal width and produced garbled overlapping text). Terminal runs (completed/failed/killed)
 * stay on disk and remain resumable via getRunAsync; only the tab row filters them out.
 *
 * Pure + order-preserving: callers rely on the same relative order as the input (store.list()
 * already returns newest-first by updatedAt).
 */
export function filterActiveRuns(runs: RunProgress[]): RunProgress[] {
  return runs.filter(r => r.status === 'running')
}

/**
 * Cap how many runs reach the tab row. Defensive fallback: even if active runs accumulate
 * (long-lived session, runaway launcher), the row must never overflow the terminal width and
 * re-introduce the garbled render. Anything past maxTabs is folded into an `overflow` count
 * that the panel renders as `+N`.
 *
 * When an active run is supplied, the window rotates to start there. This keeps
 * the selected tab at the unclipped left edge while preserving navigation order.
 */
export function capTabsForDisplay(
  runs: RunProgress[],
  maxTabs: number,
  activeRunId?: string | null,
): { runs: RunProgress[]; overflow: number } {
  const cap = Math.max(0, Math.trunc(maxTabs))
  const activeIndex = activeRunId
    ? runs.findIndex(run => run.runId === activeRunId)
    : -1
  const ordered =
    activeIndex > 0
      ? [...runs.slice(activeIndex), ...runs.slice(0, activeIndex)]
      : runs
  const visible = ordered.slice(0, cap)
  return { runs: visible, overflow: Math.max(0, runs.length - visible.length) }
}

/** tab label: workflow name + `#` + last 4 chars of runId (disambiguates same-name runs). */
export function tabLabel(workflowName: string, runId: string): string {
  return `${workflowName}#${runId.slice(-4)}`
}

/** milliseconds -> compact duration (<60s -> `Ns`; <60m -> `MmSSs`; otherwise `HhMMm`). Used by the panel header. */
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const ss = s % 60
  if (m < 60) return `${m}m${String(ss).padStart(2, '0')}s`
  const h = Math.floor(m / 60)
  return `${h}h${String(m % 60).padStart(2, '0')}m`
}
