import { AGENT_MAX_RETRIES, AGENT_RETRY_BACKOFF_MS } from '../constants.js'
import type { HostHandle, WorkflowPorts } from '../ports.js'
import type {
  JournalEntry,
  ResumePolicy,
  WorkflowResumeSummary,
} from '../types.js'
import { Budget } from './budget.js'
import { Semaphore, clampMaxConcurrency } from './concurrency.js'
import { resumePolicyAgentIds } from './journal.js'

/**
 * Resources that can be shared by sub-workflows. When nesting, semaphore/budget/agentCountBox are shared by reference,
 * and depth is temporarily +1 while executing a sub-workflow.
 */
export type SharedResources = {
  semaphore: Semaphore
  budget: Budget
  agentCountBox: { value: number }
  /** Increasing sequence number for agent() calls; stamps agent_started/agent_done for precise progress correlation. Shared across sub-workflows. */
  agentIdSeq: { value: number }
  depth: number
}

export type ResumeState = {
  /** Policy controlling this attempt (automatic retries always use checkpoint). */
  policy: ResumePolicy
  /** Original user policy reported at the terminal boundary. */
  reportPolicy?: ResumePolicy
  journalBySeq: Map<number, JournalEntry>
  maxJournalSeq: number
  reachedEntries: Map<number, JournalEntry>
  seenAgentIds: Set<number>
  replayedCount: number
  liveCount: number
  /** Lowest sequence whose old suffix can no longer be trusted. */
  divergentFrom: number | null
  /**
   * Lowest sequence at which a divergence was actually *observed* this attempt.
   * scope:"all" pre-seeds divergentFrom to 0 to force every call live, which says
   * nothing about whether the cached records are wrong — so deleting records this
   * attempt never visited is gated on this field, not on divergentFrom.
   */
  observedDivergentFrom: number | null
  journalNeedsRewrite: boolean
  /** Serializes resume decisions without serializing independent live backend work. */
  decisionTail: Promise<void>
  pendingOutcomes: Set<Promise<void>>
}

/** Execution context for a single workflow run. */
export type EngineContext = {
  ports: WorkflowPorts
  host: HostHandle
  signal: AbortSignal
  runId: string
  workflowName: string
  cwd: string
  resources: SharedResources
  journal: JournalEntry[]
  journalIndex: number
  journalInvalidated: boolean
  resumeState?: ResumeState
  currentPhase: string | null
  /** Base pause before an in-place agent retry (0 disables the wait; tests inject 0 to stay fast). */
  retryBackoffMs: number
  /** In-place retries allowed per agent() call after the first attempt (0 disables retrying). */
  agentMaxRetries: number
}

export function createSharedResources(
  budgetTotal: number | null,
  maxConcurrency?: number,
): SharedResources {
  return {
    semaphore: new Semaphore(clampMaxConcurrency(maxConcurrency)),
    budget: new Budget(budgetTotal),
    agentCountBox: { value: 0 },
    agentIdSeq: { value: 0 },
    depth: 0,
  }
}

export function createEngineContext(opts: {
  ports: WorkflowPorts
  host: HostHandle
  signal: AbortSignal
  runId: string
  workflowName: string
  cwd: string
  budgetTotal: number | null
  /** Concurrency slots for a single run; undefined → DEFAULT_MAX_CONCURRENCY. Clamped by clampMaxConcurrency. */
  maxConcurrency?: number
  journal?: JournalEntry[]
  /** Journal behavior for this attempt. Omitted journal-only contexts default to checkpoint. */
  resumePolicy?: ResumePolicy
  /** Original user selector to expose in the terminal summary. */
  resumeReportPolicy?: ResumePolicy
  /** Base pause before an in-place agent retry; undefined → AGENT_RETRY_BACKOFF_MS. */
  retryBackoffMs?: number
  /** In-place retries per agent() call; undefined → AGENT_MAX_RETRIES. */
  agentMaxRetries?: number
}): EngineContext {
  const resources = createSharedResources(opts.budgetTotal, opts.maxConcurrency)
  const journal = opts.journal ? [...opts.journal] : []
  const policy =
    opts.resumePolicy ??
    (journal.length > 0 ? ({ scope: 'checkpoint' } as const) : undefined)
  const journalBySeq = new Map(journal.map(entry => [entry.seq, entry]))
  const resumeState: ResumeState | undefined = policy
    ? {
        policy,
        ...(opts.resumeReportPolicy
          ? { reportPolicy: opts.resumeReportPolicy }
          : {}),
        journalBySeq,
        maxJournalSeq: Math.max(-1, ...journalBySeq.keys()),
        reachedEntries: new Map(),
        seenAgentIds: new Set(),
        replayedCount: 0,
        liveCount: 0,
        divergentFrom: policy.scope === 'all' ? 0 : null,
        observedDivergentFrom: null,
        journalNeedsRewrite: policy.scope === 'all',
        decisionTail: Promise.resolve(),
        pendingOutcomes: new Set(),
      }
    : undefined
  return {
    ports: opts.ports,
    host: opts.host,
    signal: opts.signal,
    runId: opts.runId,
    workflowName: opts.workflowName,
    cwd: opts.cwd,
    resources,
    journal,
    journalIndex: 0,
    journalInvalidated: false,
    ...(resumeState ? { resumeState } : {}),
    currentPhase: null,
    retryBackoffMs: opts.retryBackoffMs ?? AGENT_RETRY_BACKOFF_MS,
    agentMaxRetries: opts.agentMaxRetries ?? AGENT_MAX_RETRIES,
  }
}

export function resumeSummaryForContext(
  ctx: EngineContext,
): WorkflowResumeSummary | undefined {
  const state = ctx.resumeState
  if (!state?.reportPolicy) return undefined
  const reportPolicy = state.reportPolicy
  // Same expansion the policy module already owns; a second inline copy is how the
  // two drift when a new selector scope is added.
  const requested = resumePolicyAgentIds(reportPolicy)
  return {
    policy: reportPolicy,
    replayedCount: state.replayedCount,
    liveCount: state.liveCount,
    selectorsNotReached: requested.filter(id => !state.seenAgentIds.has(id)),
  }
}
