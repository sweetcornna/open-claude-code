// Pure type definitions. No runtime dependencies.
// WorkflowInput has been migrated to tool/schema.ts and derived via z.infer to avoid drift from the schema.

/** Shape of the script's `export const meta = {...}` (must be a plain literal). */
export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases?: Array<{ title: string; detail?: string }>
}

/** Backwards-compatible journal resume selector. Agent ids are global across nested workflows. */
export type ResumePolicy =
  | { scope: 'checkpoint' }
  | { scope: 'all' }
  | { scope: 'range'; fromAgentId: number; toAgentId: number }
  | { scope: 'agents'; agentIds: number[] }

export type AgentExecution = 'replayed' | 'live'

/** Aggregate resume telemetry attached to the terminal result/event. */
export type WorkflowResumeSummary = {
  policy: ResumePolicy
  replayedCount: number
  liveCount: number
  /** Requested range/agent selectors which were never invoked by the resumed script. */
  selectorsNotReached: number[]
}

/** Parameters passed by agent() to the AgentRunner. */
export type AgentRunParams = {
  prompt: string
  /** JSON Schema; when provided, agent returns a validated object instead of text. */
  schema?: object
  model?: string
  effort?: string
  /** Output token cap (passed through to the agent backend, e.g. LLM max_tokens). */
  maxTokens?: number
  /** Custom subagent type (resolved from the registry). */
  agentType?: string
  isolation?: 'worktree' | 'remote'
  allowedTools?: string[]
  disallowedTools?: string[]
  bashCommandClamp?: string[]
  /** Display-only; not part of the journal key. */
  label?: string
  /** Display-only; not part of the journal key. */
  phase?: string
}

/** Progress snapshot while the agent is running (onProgress callback payload; backend loop accumulates tokens/tools). */
export type AgentProgressUpdate = {
  tokenCount: number
  toolCount: number
}

/**
 * Returned by AgentRunner. The ok variant carries model/toolCount for panel display (optional; standalone backends may leave them blank).
 *
 * dead carries optional reason/detail: the journal history only records `{kind:"dead"}` with no info,
 * so during debugging you cannot distinguish "agent finished but produced no StructuredOutput" from "runAgent threw".
 * reason lets the hooks retry log, the panel, and post-hoc auditing see the cause of death immediately.
 */
export type AgentRunResult =
  | {
      kind: 'ok'
      output: string | object
      usage: { outputTokens: number }
      /** The actually-resolved model id (display-only). */
      model?: string
      /** Number of tool calls during the agent run. */
      toolCount?: number
      /** Total context tokens at completion (display-only; same basis as the real-time agent_progress). */
      tokenCount?: number
    }
  | { kind: 'skipped' }
  | {
      kind: 'dead'
      /**
       * Cause-of-death classification for log aggregation / post-hoc auditing. Optional for backward compatibility with old journals.
       * - no-structured-output: agent finished but finalize content has no StructuredOutput (neither called tools nor produced JSON in text)
       * - runagent-threw: runAgent threw a non-abort error (API failure / context overflow / runtime error)
       * - worktree-failed: isolation:'worktree' creation failed (fail-closed degradation)
       * - prompt-too-long: terminal context-overflow API error — deterministic for the identical call (backend sets retryable:false)
       * - api-error: terminal API error other than context overflow (overload / stream drop / timeout) — transient, retry may succeed
       * - agent-total-timeout / agent-no-progress: configured execution limits — deterministic for the identical run
       * - agent-cancelled: this child agent was cancelled without aborting its parent workflow
       * - unknown: unclassified (compatible with old backends / third-party adapters)
       */
      reason?:
        | 'no-structured-output'
        | 'runagent-threw'
        | 'worktree-failed'
        | 'prompt-too-long'
        | 'api-error'
        | 'agent-total-timeout'
        | 'agent-no-progress'
        | 'agent-cancelled'
        | 'unknown'
      /** Detail (error message / text preview) for logs; not shown to end users. */
      detail?: string
      /**
       * false = deterministic failure: re-running the identical call cannot succeed
       * (e.g. prompt exceeds the context window), so hooks skips the in-place retry.
       * Absent/true = treated as transient.
       */
      retryable?: boolean
    }

/** A single record in the journal. seq = agent() call sequence number; read() re-sorts by it to stabilize resume. */
export type JournalEntry = {
  /** v2 entries are chained SHA-256 checkpoints; unprefixed/v1 keys are legacy identities. */
  key: string
  /** agent() call order (from agentIdSeq; monotonically increasing across sub-workflows). */
  seq: number
  result: AgentRunResult
}

/** Progress events. All variants carry runId so the adapter can route to the corresponding task (multiple concurrent workflows). */
export type ProgressEvent =
  | {
      type: 'run_started'
      runId: string
      /** Identity of this host-owned execution generation, when the host has one. */
      taskId?: string
      instanceId?: number
      workflowName: string
      meta: WorkflowMeta | null
      resumePolicy?: ResumePolicy
    }
  | { type: 'phase_started'; runId: string; phase: string }
  | { type: 'phase_done'; runId: string; phase: string }
  | {
      type: 'agent_started'
      runId: string
      agentId: number
      label?: string
      phase?: string
    }
  | {
      type: 'agent_done'
      runId: string
      agentId: number
      label?: string
      phase?: string
      result: AgentRunResult
      /** Always emitted by the engine; optional so older host-authored events remain valid. */
      execution?: AgentExecution
    }
  | {
      type: 'agent_progress'
      runId: string
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
    }
  /**
   * A failed agent() call is about to be retried in place. Distinct from a second
   * agent_started on purpose: the agent never stopped being this run's agent #N, so
   * the consumer must keep the original startedAt (the elapsed clock spans the whole
   * retry chain, backoff included) and only record that a retry is happening.
   * Transient/UI-only — never journaled, so it cannot affect resume.
   */
  | {
      type: 'agent_retry'
      runId: string
      agentId: number
      label?: string
      phase?: string
      /** 1-based number of the retry that is about to be scheduled. */
      attempt: number
      /** Retries allowed for this failure (per-cause budget, so it can differ per attempt). */
      limit: number
      /** Cause of the failure that triggered this retry (dead reason, or 'threw'). */
      reason: string
      /** Bounded detail for display (error message / dead detail preview). */
      detail?: string
      /** Backoff in ms the engine will wait before the retry actually starts. */
      delayMs: number
    }
  | { type: 'log'; runId: string; message: string }
  | {
      type: 'run_done'
      runId: string
      /** Present on engine/tool-authored events so failures before run_started keep their identity. */
      workflowName?: string
      /** Latest wrapper generation; allows detached pre-start failures to persist identity too. */
      taskId?: string
      instanceId?: number
      status: 'completed' | 'failed' | 'killed'
      returnValue?: unknown
      error?: string
      resume?: WorkflowResumeSummary
    }

/** Engine run result. */
export type WorkflowRunResult = {
  status: 'completed' | 'failed' | 'killed'
  returnValue?: unknown
  error?: string
  resume?: WorkflowResumeSummary
}
