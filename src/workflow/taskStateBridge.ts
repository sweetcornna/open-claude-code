/**
 * Bridge for streaming live workflow run progress into the background task state.
 *
 * Two halves of this feature already existed and were never wired together: the engine
 * feeds a reactive {@link ProgressStore} (phases, agents, status) consumed by the
 * `/workflows` panel, and every run also registers a `LocalWorkflowTask` that the footer
 * pill and the Shift+Down dialog render from `AppState`. Nothing copied the former into
 * the latter, so outside the panel a running workflow was just an opaque
 * "N background workflows".
 *
 * This module subscribes to the store and denormalizes the live view into the task:
 * a one-line `summary` (`review (2/4) · 3 agents`) plus `agentCount`.
 *
 * Update cadence is deliberately conservative — every write lands in AppState and costs a
 * Yoga layout pass plus an ink diff:
 *
 * - Only **material** transitions schedule a write: run status, current phase, or the number
 *   of *running* agents. `agent_progress` token/tool ticks (the highest-frequency event by
 *   far) change none of those and are dropped before any React work happens.
 * - Writes are throttled per run with a **trailing** edge ({@link TASK_STATE_THROTTLE_MS}),
 *   so a burst of phase/agent transitions collapses into one commit carrying the newest state.
 * - It is inert when the run has no task binding (headless runs, or a run whose binding was
 *   already reclaimed on completion). Headless turn-boundary reporting is unaffected — that
 *   is `notifications.ts`'s channel and it stays untouched.
 */
import type { SetAppState } from '../Task.js'
import type { LocalWorkflowTaskState } from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import { updateTaskState } from '../utils/task/framework.js'
import type { WorkflowTaskBindings } from './ports.js'
import type { ProgressStore, RunProgress } from './progress/store.js'

/**
 * Trailing-throttle window for task-state writes. 500ms is below the threshold where a
 * phase transition reads as laggy, while still collapsing the burst of agent_started
 * events a parallel stage emits within a few milliseconds of each other.
 */
export const TASK_STATE_THROTTLE_MS = 500

/** Denormalized snapshot pushed onto the LocalWorkflowTask. */
export type WorkflowTaskProgress = {
  runId: string
  /** One-line live status, e.g. `review (2/4) · 3 agents`. */
  summary: string
  /** Total agents spawned by the run so far (mirrors RunProgress.agentCount). */
  agentCount: number
}

/** Write side-effect abstraction (lets tests inject a spy without mocking AppState). */
export type WorkflowTaskProgressWriter = (
  progress: WorkflowTaskProgress,
) => void

/** Clock + scheduler seam, so the throttle can be tested without sleeping. */
export type WorkflowBridgeClock = {
  now(): number
  /** Runs `fn` after `ms`; the returned function cancels a not-yet-fired timer. */
  schedule(fn: () => void, ms: number): () => void
}

const realClock: WorkflowBridgeClock = {
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    // A pending cosmetic refresh must never keep the process alive on exit.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    return () => clearTimeout(timer)
  },
}

/** Number of agents currently in flight (the figure the summary reports). */
export function countRunningAgents(run: Pick<RunProgress, 'agents'>): number {
  return run.agents.filter(a => a.status === 'running').length
}

/**
 * `phase (idx/total)` for the phase the run is currently in.
 *
 * Three fallbacks, mirroring what `panel/selectors.ts#mergePhases` already learned the hard
 * way about how scripts actually emit phases:
 * 1. `currentPhase` — set by `phase_started`.
 * 2. Newest still-running entry in `phases` — `phase_done` clears `currentPhase` and only the
 *    next `phase_started` re-sets it, so without this the label blinks out between stages.
 * 3. The phase of a running agent — the canonical pipeline pattern passes `opts.phase`
 *    straight to `agent()` and never calls `phase()`, so `phases` stays empty for those runs.
 *
 * Position comes from `declaredPhases` (the script's declared pipeline) when meta supplied
 * it, otherwise from the phases actually observed so far.
 */
export function formatPhaseLabel(
  run: Pick<
    RunProgress,
    'phases' | 'declaredPhases' | 'currentPhase' | 'agents'
  >,
): string | null {
  const newestAgents = [...run.agents].reverse()
  const current =
    run.currentPhase ??
    [...run.phases].reverse().find(p => p.status === 'running')?.title ??
    newestAgents.find(a => a.status === 'running' && a.phase)?.phase ??
    // Nothing in flight: keep showing the phase the last agent belonged to rather than
    // dropping back to "starting" — an ambient indicator should stay sticky.
    newestAgents.find(a => a.phase)?.phase ??
    null
  if (!current) return null
  const order =
    run.declaredPhases.length > 0
      ? run.declaredPhases
      : [
          ...new Set([
            ...run.phases.map(p => p.title),
            ...run.agents.flatMap(a => (a.phase ? [a.phase] : [])),
          ]),
        ]
  const index = order.indexOf(current)
  if (index < 0 || order.length === 0) return current
  return `${current} (${index + 1}/${order.length})`
}

/**
 * One-line live status for the footer pill / task list, e.g. `review (2/4) · 3 agents`.
 * Falls back to `starting` before the first phase or agent shows up, so the pill never
 * renders a bare separator.
 */
export function formatRunSummary(
  run: Pick<
    RunProgress,
    'phases' | 'declaredPhases' | 'currentPhase' | 'agents'
  >,
): string {
  const parts: string[] = []
  const phase = formatPhaseLabel(run)
  if (phase) parts.push(phase)
  const running = countRunningAgents(run)
  if (running > 0) parts.push(running === 1 ? '1 agent' : `${running} agents`)
  return parts.length > 0 ? parts.join(' · ') : 'starting'
}

/**
 * The three transitions that are worth a re-render: run status, the phase on display, and
 * the number of running agents. Everything else the store records (token counts, tool
 * counts, agent labels, updatedAt) is invisible in the surfaces this bridge feeds, so it
 * must not reach AppState.
 *
 * The phase component is the *rendered* label rather than raw `currentPhase`: the label has
 * fallbacks (see {@link formatPhaseLabel}) and keying off the raw field would let the pill
 * go stale when only a fallback moved.
 */
function materialSignature(run: RunProgress): string {
  return `${run.status}|${formatPhaseLabel(run) ?? ''}|${countRunningAgents(run)}`
}

/** Default writer: patch the bound LocalWorkflowTask through the normal task framework. */
function makeAppStateWriter(
  bindings: WorkflowTaskBindings,
): WorkflowTaskProgressWriter {
  return progress => {
    const taskId = bindings.getTaskIdForRun(progress.runId)
    const setAppState: SetAppState | undefined = bindings.getSetAppStateForRun(
      progress.runId,
    )
    // No binding — headless run, or the run already reached a terminal state and the
    // registrar reclaimed it. Inert by design.
    if (!taskId || !setAppState) return
    updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task =>
      task.summary === progress.summary &&
      task.agentCount === progress.agentCount
        ? // Same reference short-circuits updateTaskState's commit entirely.
          task
        : {
            ...task,
            summary: progress.summary,
            agentCount: progress.agentCount,
          },
    )
  }
}

type RunThrottleState = {
  /** Newest material signature seen (already written or awaiting the trailing edge). */
  signature: string
  lastWriteAt: number
  cancelPending: (() => void) | null
}

/**
 * Subscribe the background task state to the workflow progress store.
 *
 * @returns an unsubscribe that also cancels any trailing writes still in flight.
 */
export function installWorkflowTaskStateBridge(
  store: ProgressStore,
  bindings: WorkflowTaskBindings,
  opts: {
    write?: WorkflowTaskProgressWriter
    throttleMs?: number
    clock?: WorkflowBridgeClock
  } = {},
): () => void {
  const write = opts.write ?? makeAppStateWriter(bindings)
  const throttleMs = opts.throttleMs ?? TASK_STATE_THROTTLE_MS
  const clock = opts.clock ?? realClock
  const states = new Map<string, RunThrottleState>()

  const forget = (runId: string): void => {
    const state = states.get(runId)
    if (!state) return
    state.cancelPending?.()
    states.delete(runId)
  }

  /** Read the run afresh at flush time — the trailing edge must carry the newest state. */
  const flush = (runId: string, state: RunThrottleState): void => {
    const run = store.get(runId)
    state.lastWriteAt = clock.now()
    if (!run || run.status !== 'running') return
    write({
      runId,
      summary: formatRunSummary(run),
      agentCount: run.agentCount,
    })
  }

  const unsubscribe = store.subscribe(() => {
    for (const run of store.getSnapshot()) {
      // Terminal runs are owned by taskRegistrar.complete/fail/kill, which already write
      // the final status onto the task. Drop our per-run bookkeeping instead of racing it.
      if (run.status !== 'running') {
        forget(run.runId)
        continue
      }
      const signature = materialSignature(run)
      const existing = states.get(run.runId)
      if (existing && existing.signature === signature) continue

      const state = existing ?? {
        signature,
        // -Infinity, not 0: the first material change for a run must never be delayed
        // by the throttle window (clock.now() can legitimately start at 0 in tests).
        lastWriteAt: Number.NEGATIVE_INFINITY,
        cancelPending: null,
      }
      state.signature = signature
      states.set(run.runId, state)

      // A trailing write is already scheduled — it will pick up this newer signature.
      if (state.cancelPending) continue

      const elapsed = clock.now() - state.lastWriteAt
      if (elapsed >= throttleMs) {
        flush(run.runId, state)
        continue
      }
      const runId = run.runId
      state.cancelPending = clock.schedule(() => {
        state.cancelPending = null
        flush(runId, state)
      }, throttleMs - elapsed)
    }
  })

  return () => {
    unsubscribe()
    for (const runId of [...states.keys()]) forget(runId)
  }
}
