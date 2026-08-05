// Engine-level constants. No runtime dependencies.

/**
 * Workflow tool name. PascalCase matches the system's other tools (Agent/Bash/CronCreate…),
 * otherwise the case-sensitive toolMatchesName would fail on the model's natural select:Workflow.
 */
export const WORKFLOW_TOOL_NAME = 'Workflow'

/** Directory for user-named workflow files (relative to project root). */
export const WORKFLOW_DIR_NAME = '.occ/workflows'

/** Persistence directory for workflow runs (journal + run records). */
export const WORKFLOW_RUNS_DIR = '.occ/workflow-runs'

/** Supported script extensions for named workflows (in priority order). */
export const WORKFLOW_SCRIPT_EXTENSIONS = ['.ts', '.js', '.mjs'] as const

/**
 * Concurrency: default semaphore permits per workflow run.
 * History: first min(CAP, cpuCores - 2); then a fixed 3 — to avoid fanning out a dozen
 * agents at once on multi-core machines; raised to 6 (2026-08) because 3 left the typical
 * fan-out workflow (parallel over 8-20 items) serialized behind the semaphore for most of
 * its wall clock. The real ceiling is upstream anyway — the Agent tool's own concurrent-spawn
 * budget (20) and the provider's rate limit — not the local box, which only shuttles streams.
 * A single run can override this via the Workflow tool's maxConcurrency input (still clamped by CAP);
 * the host may also change the default via OCC_WORKFLOW_MAX_CONCURRENCY (read host-side —
 * this package stays free of process.env).
 */
export const DEFAULT_MAX_CONCURRENCY = 6

/** Absolute cap on user-supplied maxConcurrency (anti-abuse). */
export const MAX_CONCURRENCY_CAP = 16

/** Total cap on agent() calls within a single workflow lifecycle. */
export const MAX_TOTAL_AGENTS = 1000

/**
 * Base pause before an in-place agent retry (doubled per attempt, see AGENT_RETRY_JITTER_RATIO).
 * The dominant transient failures (529 overload, stream drop) need breathing room — an
 * immediate identical call mostly lands on the same congested endpoint and doubles the load.
 */
export const AGENT_RETRY_BACKOFF_MS = 2_000

/**
 * How many in-place retries an agent() call gets after its first attempt (so at most
 * 1 + AGENT_MAX_RETRIES backend invocations).
 *
 * Deliberately small: the API transport layer already retries transient network errors
 * with its own exponential backoff, so these two multiply. A double-digit engine-side
 * budget on top of that turns one wedged endpoint into tens of minutes of a workflow
 * looking alive while making no progress. 3 is the engine-level backstop for failures
 * the transport cannot see (terminal dead results surfaced as messages, adapter throws).
 */
export const AGENT_MAX_RETRIES = 3

/**
 * Upper bound on the random fraction added to each backoff (0.25 → 2s becomes 2.0-2.5s).
 * Spreads the retry storm when a whole parallel() batch dies on the same overloaded
 * endpoint at the same instant — without jitter they all come back in lockstep.
 */
export const AGENT_RETRY_JITTER_RATIO = 0.25

/**
 * Per-cause override of AGENT_MAX_RETRIES (absent → AGENT_MAX_RETRIES).
 *
 * no-structured-output is the one death whose retry unit is a *complete* agent run that
 * already burned its tokens (the agent worked, then failed to emit JSON), unlike an
 * api-error that usually dies before producing anything. Four full runs of a subagent
 * that keeps narrating instead of emitting the object costs far more than the null it
 * saves — and if it missed the schema twice, the prompt/schema is the problem, not luck.
 */
export const AGENT_MAX_RETRIES_BY_REASON: Readonly<Record<string, number>> = {
  'no-structured-output': 1,
  // worktree-failed only reaches a retry at all when the backend judged it transient
  // (git lock contention — a sibling agent held the index/ref lock for the moment it
  // takes to fetch a base ref); everything else on that path is marked retryable:false.
  // A lock collision clears within one backoff or not at all, so a second and third
  // attempt just re-run git plumbing against a lock somebody is evidently holding.
  'worktree-failed': 1,
}

/** Items cap per single parallel()/pipeline() call. */
export const MAX_ITEMS_PER_CALL = 4096
