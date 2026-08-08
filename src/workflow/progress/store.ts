import type { ProgressEvent } from '@open-claude-code/workflow-engine'
import type { ProgressBus } from './bus.js'

/**
 * Max characters of an agent's return value kept for the detail view. The
 * store is persisted to state.json and held for the whole session, so a
 * fan-out run must not pin every agent's full output in memory — a preview is
 * enough to tell "returned the findings array" from "returned an empty
 * string", which is what the detail view is for.
 */
export const OUTPUT_PREVIEW_MAX = 400

/**
 * Serialize an agent's return value into a bounded preview string.
 * Objects go through JSON so the shape is visible; unserializable values
 * (cycles, BigInt) degrade to their String() form rather than throwing.
 */
export function buildOutputPreview(
  output: string | object,
  max: number = OUTPUT_PREVIEW_MAX,
): string {
  let text: string
  if (typeof output === 'string') {
    text = output
  } else {
    try {
      text = JSON.stringify(output) ?? String(output)
    } catch {
      text = String(output)
    }
  }
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export type AgentProgress = {
  /** Unique id stamped by the engine, precisely correlates started/done (fixes the old LIFO race condition). */
  id: number
  label?: string
  phase?: string
  status: 'running' | 'done'
  /** Whether this call executed now or was replayed from the resume journal. */
  execution?: 'live' | 'replayed'
  resultKind?: string
  /** Only meaningful when done·ok: output is an object -> 'object', otherwise -> 'text'. None for dead/skipped. */
  outputShape?: 'text' | 'object'
  /** Actually parsed model id (carried in by agent_done; none while running). */
  model?: string
  /** Cumulative context tokens (live via agent_progress / final value settled by agent_done). */
  tokenCount?: number
  /** Cumulative tool-call count (live via agent_progress / final value settled by agent_done). */
  toolCount?: number
  /** agent_started wall-clock (ms). Drives the list's time column and the detail view's duration. */
  startedAt?: number
  /** agent_done wall-clock (ms). Absent while running — the UI measures against Date.now() instead. */
  endedAt?: number
  /** Wall-clock of the latest start/progress/retry/done event for control-plane status. */
  lastActivityAt?: number
  /** done·ok only: bounded preview of the return value (see {@link buildOutputPreview}). */
  outputPreview?: string
  /** done·ok only: tokens the agent generated (result.usage.outputTokens). */
  outputTokens?: number
  /**
   * done·dead only: cause-of-death classification from the engine. Surfaced in
   * the detail view — without it a failed agent is an unexplained ✗ and the
   * user has to go read the journal to find out why.
   */
  failureReason?: string
  /** done·dead only: engine-supplied detail (error message / text preview). */
  failureDetail?: string
  /** done·dead only: false = deterministic failure, re-running cannot succeed. */
  retryable?: boolean
  /**
   * In-place retries the engine has started for this agent (from agent_retry).
   * Present while still running: the row is "attempt retryCount+1", and startedAt
   * deliberately still points at the FIRST attempt so the elapsed column shows the
   * true cost of the whole retry chain (backoff included).
   */
  retryCount?: number
  /** Retries the engine will allow for the failure that triggered the latest retry. */
  retryLimit?: number
  /**
   * Why the latest retry happened (engine dead reason, or 'threw'). Kept separate from
   * failureReason: this one describes an attempt the agent already survived, while
   * failureReason describes the terminal result. An agent can end ok with this set.
   */
  lastFailureReason?: string
  /** Bounded detail of the failure that triggered the latest retry. */
  lastFailureDetail?: string
  /** Wall clock of the latest agent_retry; with delayMs it tells the UI a backoff is in progress. */
  retryingSince?: number
  /** Backoff the engine waits before the retry attempt actually starts. */
  retryDelayMs?: number
}

export type RunProgress = {
  runId: string
  /** Latest host wrapper generation; retained in terminal state.json for status/query. */
  taskId?: string
  instanceId?: number
  workflowName: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  phases: Array<{ title: string; status: 'running' | 'done' }>
  /** From run_started.meta.phases[].title; the panel uses this to show pending(○) phases. [] when no meta. */
  declaredPhases: string[]
  currentPhase: string | null
  agents: AgentProgress[]
  agentCount: number
  returnValue?: unknown
  error?: string
  /** run_started timestamp (used by the panel to compute run duration). */
  startedAt: number
  /** workflow description (from run_started.meta.description). */
  description?: string
  updatedAt: number
}

export type ProgressStore = {
  apply(event: ProgressEvent): void
  list(): RunProgress[]
  get(runId: string): RunProgress | undefined
  /** Directly inject a run read from disk (bypassing bus); skips existing runId - in-memory takes priority. */
  hydrate(run: RunProgress): void
  /** Forget a terminal run after its host wrapper grace period. */
  remove(runId: string): void
  /** For useSyncExternalStore: returns a stable reference, the same array when no change. */
  subscribe(listener: () => void): () => void
  getSnapshot(): RunProgress[]
}

/** Build a reactive store from the bus: subscribe to the bus, reduce events, notify React subscribers. */
export function createProgressStoreFromBus(bus: ProgressBus): ProgressStore {
  const byId = new Map<string, RunProgress>()
  let snapshot: RunProgress[] = []
  const listeners = new Set<() => void>()

  const notify = (): void => {
    snapshot = [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const fn of listeners) fn()
  }

  const ensure = (runId: string, workflowName: string): RunProgress => {
    let p = byId.get(runId)
    if (!p) {
      p = {
        runId,
        workflowName,
        status: 'running',
        phases: [],
        declaredPhases: [],
        currentPhase: null,
        agents: [],
        agentCount: 0,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      }
      byId.set(runId, p)
    }
    return p
  }

  const apply = (event: ProgressEvent): void => {
    // log produces no visible state change (panel has no log view): early exit to avoid pointless snapshot rebuild and React re-render
    if (event.type === 'log') return
    const runId = event.runId
    const p = ensure(
      runId,
      'workflowName' in event ? (event.workflowName ?? 'workflow') : 'workflow',
    )
    p.updatedAt = Date.now()
    switch (event.type) {
      case 'run_started':
        // A resume intentionally reuses runId but represents a fresh live
        // instance. Do not carry terminal output, old agents, phases, or timing
        // into the new generation — besides lying in the panel, stale running
        // rows can make one current workflow look like several old ones.
        p.workflowName = event.workflowName
        p.taskId = event.taskId
        p.instanceId = event.instanceId
        p.status = 'running'
        p.phases = []
        p.declaredPhases = event.meta?.phases?.map(ph => ph.title) ?? []
        p.currentPhase = null
        p.agents = []
        p.agentCount = 0
        p.returnValue = undefined
        p.error = undefined
        p.startedAt = p.updatedAt
        p.description = event.meta?.description ?? undefined
        break
      case 'phase_started':
        if (!p.phases.some(ph => ph.title === event.phase)) {
          p.phases.push({ title: event.phase, status: 'running' })
        }
        p.currentPhase = event.phase
        break
      case 'phase_done':
        for (const ph of p.phases)
          if (ph.title === event.phase) ph.status = 'done'
        if (p.currentPhase === event.phase) p.currentPhase = null
        break
      case 'agent_started': {
        let a = p.agents.find(x => x.id === event.agentId)
        if (!a) {
          a = {
            id: event.agentId,
            label: event.label,
            phase: event.phase,
            status: 'running',
            execution: 'live',
            startedAt: p.updatedAt,
            lastActivityAt: p.updatedAt,
          }
          p.agents.push(a)
          p.agentCount = p.agents.length
        } else {
          a.status = 'running'
          a.label = event.label
          a.phase = event.phase
          a.execution = 'live'
          a.startedAt = p.updatedAt
          a.lastActivityAt = p.updatedAt
          // A genuinely fresh attempt at this agent id — the workflow-level journal
          // resume builds a new context and hands out ids from 0 again. Restart the
          // clock and clear the previous attempt's terminal fields so the row does not
          // show a stale ✗/duration while running. In-place engine retries do NOT come
          // through here (they emit agent_retry precisely so startedAt survives).
          a.endedAt = undefined
          a.resultKind = undefined
          a.outputShape = undefined
          a.outputPreview = undefined
          a.outputTokens = undefined
          a.model = undefined
          a.tokenCount = undefined
          a.toolCount = undefined
          a.failureReason = undefined
          a.failureDetail = undefined
          a.retryable = undefined
          a.retryCount = undefined
          a.retryLimit = undefined
          a.lastFailureReason = undefined
          a.lastFailureDetail = undefined
          a.retryingSince = undefined
          a.retryDelayMs = undefined
        }
        break
      }
      case 'agent_retry': {
        // Deliberately does not touch startedAt/endedAt: the agent never left 'running',
        // and its elapsed time spans every attempt plus the backoff between them.
        const ar = p.agents.find(x => x.id === event.agentId)
        if (ar) {
          ar.status = 'running'
          ar.retryCount = event.attempt
          ar.retryLimit = event.limit
          ar.lastFailureReason = event.reason
          ar.lastFailureDetail = event.detail
          ar.retryingSince = p.updatedAt
          ar.retryDelayMs = event.delayMs
          ar.lastActivityAt = p.updatedAt
        }
        break
      }
      case 'agent_progress': {
        // live progress: only update token/tool (high frequency, but once per agent message, frequency is controllable).
        const ap = p.agents.find(x => x.id === event.agentId)
        if (ap) {
          ap.tokenCount = event.tokenCount
          ap.toolCount = event.toolCount
          ap.lastActivityAt = p.updatedAt
        }
        break
      }
      case 'agent_done': {
        let a = p.agents.find(x => x.id === event.agentId)
        if (!a) {
          a = {
            id: event.agentId,
            label: event.label,
            phase: event.phase,
            status: 'done',
            execution: event.execution ?? 'live',
            endedAt: p.updatedAt,
            lastActivityAt: p.updatedAt,
          }
          p.agents.push(a)
          p.agentCount = p.agents.length
        }
        a.status = 'done'
        a.execution = event.execution ?? a.execution ?? 'live'
        a.resultKind = event.result.kind
        a.endedAt = p.updatedAt
        a.lastActivityAt = p.updatedAt
        if (event.result.kind === 'ok') {
          a.outputShape =
            typeof event.result.output === 'object' &&
            event.result.output !== null
              ? 'object'
              : 'text'
          a.outputPreview = buildOutputPreview(event.result.output)
          a.outputTokens = event.result.usage?.outputTokens
          a.tokenCount = event.result.tokenCount
          a.toolCount = event.result.toolCount
          a.model = event.result.model
        } else if (event.result.kind === 'dead') {
          a.failureReason = event.result.reason ?? 'unknown'
          a.failureDetail = event.result.detail
          a.retryable = event.result.retryable
        }
        break
      }
      case 'run_done': {
        p.status = event.status
        if (event.taskId !== undefined) p.taskId = event.taskId
        if (event.instanceId !== undefined) p.instanceId = event.instanceId
        if (event.returnValue !== undefined) p.returnValue = event.returnValue
        if (event.error !== undefined) p.error = event.error
        // The run is over, so nothing can still be running. A killed run tears down the
        // engine mid-agent (and an agent parked in a retry backoff is torn down without
        // ever emitting agent_done), leaving rows spinning forever with an elapsed timer
        // that keeps climbing after the run's own status went terminal. Reap them here:
        // 'dead' is the honest classification (no result was ever produced) and keeps the
        // panel's failed-bucket / ✗ rendering working without teaching it a new kind.
        for (const a of p.agents) {
          if (a.status !== 'running') continue
          a.status = 'done'
          a.endedAt = p.updatedAt
          a.lastActivityAt = p.updatedAt
          a.resultKind = 'dead'
          a.failureReason = `run-${event.status === 'completed' ? 'ended' : event.status}`
          a.retryingSince = undefined
          a.retryDelayMs = undefined
        }
        break
      }
    }
    notify()
  }

  bus.subscribe(apply)
  return {
    apply,
    list: () => snapshot,
    get: id => byId.get(id),
    hydrate(run) {
      if (byId.has(run.runId)) return
      byId.set(run.runId, run)
      notify()
    },
    remove(runId) {
      if (!byId.delete(runId)) return
      notify()
    },
    subscribe: fn => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: () => snapshot,
  }
}
