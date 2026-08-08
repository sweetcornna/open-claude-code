import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKFLOW_DIR_NAME } from '../constants.js'
import type { HostHandle, WorkflowPorts } from '../ports.js'
import type {
  JournalEntry,
  ResumePolicy,
  WorkflowResumeSummary,
  WorkflowRunResult,
} from '../types.js'
import { BudgetExhaustedError } from './budget.js'
import {
  createEngineContext,
  type EngineContext,
  resumeSummaryForContext,
} from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { makeHooks, type SubWorkflowRunner } from './hooks.js'
import { isSelectiveResumePolicy, resolveResumePolicy } from './journal.js'
import { resolveNamedWorkflow } from './namedWorkflows.js'
import { parseScript, type ParsedScript } from './script.js'

export type RunWorkflowOptions = {
  /** Already-resolved script source code. */
  script: string
  args?: unknown
  runId: string
  workflowName?: string
  /** Optional host wrapper identity for live and persisted control-plane status. */
  taskId?: string
  instanceId?: number
  ports: WorkflowPorts
  host: HostHandle
  signal: AbortSignal
  cwd: string
  budgetTotal: number | null
  /** Concurrency slots for a single run; undefined → DEFAULT_MAX_CONCURRENCY. */
  maxConcurrency?: number
  /** resume: when true, load the existing journal and replay. */
  resume?: boolean
  /** Completed calls to rerun. Omitted preserves checkpoint behavior. */
  resumePolicy?: ResumePolicy
  /** Whether the script source hash changed on resume. When true, ignore the journal and re-run everything. */
  scriptChanged?: boolean
  /** Named workflow directory relative to cwd. */
  workflowDir?: string
  /**
   * One automatic journal-resume when the script fails (default on). The retry
   * replays every recorded success instantly and re-runs only failed agents, so
   * a transient API failure mid-run doesn't cost the whole workflow. false disables.
   */
  autoRetryOnFailure?: boolean
  /** Base pause before an in-place agent retry; undefined → AGENT_RETRY_BACKOFF_MS. Tests inject 0. */
  retryBackoffMs?: number
  /** In-place retries per agent() call; undefined → AGENT_MAX_RETRIES. */
  agentMaxRetries?: number
}

export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const { ports } = opts

  let resumePolicy: ResumePolicy | undefined
  try {
    resumePolicy = resolveResumePolicy(opts.resumePolicy, opts.resume === true)
    if (
      opts.scriptChanged &&
      resumePolicy &&
      isSelectiveResumePolicy(resumePolicy)
    ) {
      throw new WorkflowError(
        'Selective resume requires an unchanged workflow script; use scope "all" to rerun a changed script',
      )
    }
  } catch (error) {
    const message = (error as Error).message
    ports.progressEmitter.emit({
      type: 'run_done',
      runId: opts.runId,
      workflowName: opts.workflowName ?? 'workflow',
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
      status: 'failed',
      error: message,
    })
    return { status: 'failed', error: message }
  }

  let parsed: ParsedScript
  try {
    parsed = parseScript(opts.script)
  } catch (e) {
    const error = (e as Error).message
    ports.progressEmitter.emit({
      type: 'run_done',
      runId: opts.runId,
      workflowName: opts.workflowName ?? 'workflow',
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
      ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
      status: 'failed',
      error,
    })
    return { status: 'failed', error }
  }

  const workflowName = opts.workflowName ?? parsed.meta?.name ?? 'workflow'

  // Load the journal (only on resume and when the script is unchanged)
  let journal: JournalEntry[] = []
  let journalInvalidated = false
  if (opts.resume && !opts.scriptChanged) {
    journal = await ports.journalStore.read(opts.runId)
  } else if (opts.scriptChanged) {
    await ports.journalStore.truncate(opts.runId)
    journalInvalidated = true
    // Say so out loud. A resume that silently discards every checkpoint is
    // indistinguishable from one that replayed them — the run just costs a full
    // fresh fan-out again while looking like it resumed.
    ports.logger.warn?.(
      `resume ${opts.runId}: script changed since the recorded run — journal discarded, every agent() call re-runs`,
    )
    ports.progressEmitter.emit({
      type: 'log',
      runId: opts.runId,
      message:
        'script changed since the recorded run — journal discarded, resuming as a full fresh run',
    })
  }

  ports.progressEmitter.emit({
    type: 'run_started',
    runId: opts.runId,
    workflowName,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
    meta: parsed.meta,
    ...(resumePolicy ? { resumePolicy } : {}),
  })

  // One attempt = fresh context + full script execution. retryEligible marks failures
  // worth an automatic journal-resume: agent-induced script errors (a dead agent's null
  // exploding in script code) are transient once the agent is re-run; WorkflowError
  // (config/caps/parse — deterministic) and BudgetExhaustedError (a fresh context would
  // reset spent and overspend) are not.
  const executeAttempt = async (
    attemptJournal: JournalEntry[],
    invalidated: boolean,
    attemptPolicy?: ResumePolicy,
  ): Promise<{
    result: WorkflowRunResult
    retryEligible: boolean
    resumeSummary?: WorkflowResumeSummary
  }> => {
    const ctx = createEngineContext({
      ports,
      host: opts.host,
      signal: opts.signal,
      runId: opts.runId,
      workflowName,
      cwd: opts.cwd,
      budgetTotal: opts.budgetTotal,
      maxConcurrency: opts.maxConcurrency,
      journal: attemptJournal,
      ...(attemptPolicy ? { resumePolicy: attemptPolicy } : {}),
      ...(resumePolicy ? { resumeReportPolicy: resumePolicy } : {}),
      ...(opts.retryBackoffMs !== undefined
        ? { retryBackoffMs: opts.retryBackoffMs }
        : {}),
      ...(opts.agentMaxRetries !== undefined
        ? { agentMaxRetries: opts.agentMaxRetries }
        : {}),
    })
    if (invalidated) ctx.journalInvalidated = true

    // Sub-workflow executor: reuses the same ctx (sharing journal/concurrency/budget/counters), temporarily +1 depth
    const runSubWorkflow: SubWorkflowRunner = async sub => {
      const script = await resolveSubScript(
        sub,
        opts.cwd,
        opts.workflowDir ?? WORKFLOW_DIR_NAME,
      )
      let subParsed: ParsedScript
      try {
        subParsed = parseScript(script)
      } catch (e) {
        throw new WorkflowError(
          `Sub-workflow script error: ${(e as Error).message}`,
        )
      }
      const prevDepth = ctx.resources.depth
      ctx.resources.depth += 1
      try {
        const subHooks = makeHooks(ctx, runSubWorkflow)
        return await subParsed.execute(subHooks, sub.args, ctx.resources.budget)
      } finally {
        ctx.resources.depth = prevDepth
      }
    }

    const hooks = makeHooks(ctx, runSubWorkflow)

    // hook.phase only emits phase_done for the previous phase when switching phases; when the script ends,
    // currentPhase is the last phase, and there is no subsequent phase() to trigger its phase_done → the left pane of the UI
    // would stay running forever (the agent list already shows ✓ done). Emit one before the terminal state — shared by all paths.
    const emitTerminalPhaseDone = (): void => {
      if (!ctx.currentPhase) return
      ports.progressEmitter.emit({
        type: 'phase_done',
        runId: opts.runId,
        phase: ctx.currentPhase,
      })
    }

    let result: WorkflowRunResult
    let retryEligible = false
    try {
      const returnValue = await parsed.execute(
        hooks,
        opts.args,
        ctx.resources.budget,
      )
      result = { status: 'completed', returnValue }
    } catch (e) {
      if (e instanceof WorkflowAbortedError) {
        result = { status: 'killed' }
      } else {
        result = { status: 'failed', error: (e as Error).message }
        retryEligible = !(
          e instanceof WorkflowError || e instanceof BudgetExhaustedError
        )
      }
    }
    try {
      await finalizeAttemptJournal(ctx, result.status === 'completed')
    } catch (error) {
      result = {
        status: 'failed',
        error: `Failed to persist resumed journal: ${(error as Error).message}`,
      }
      retryEligible = false
    }
    emitTerminalPhaseDone()
    const attemptResumeSummary = resumeSummaryForContext(ctx)
    return {
      result,
      retryEligible,
      ...(attemptResumeSummary ? { resumeSummary: attemptResumeSummary } : {}),
    }
  }

  let firstAttempt = await executeAttempt(
    journal,
    journalInvalidated,
    resumePolicy,
  )
  let { result, retryEligible } = firstAttempt
  let resumeSummary = firstAttempt.resumeSummary

  // One automatic journal-resume on failure: reload the journal (now holding every
  // success from the first attempt), replay it, and re-run only what failed. This is
  // the checkpoint-retry the journal exists for — a transient mid-run API failure
  // shouldn't cost the entire workflow.
  if (
    result.status === 'failed' &&
    retryEligible &&
    opts.autoRetryOnFailure !== false &&
    !opts.signal.aborted
  ) {
    ports.progressEmitter.emit({
      type: 'log',
      runId: opts.runId,
      message: `workflow failed (${result.error ?? 'unknown'}); auto-resuming once from journal`,
    })
    const retryJournal = await ports.journalStore.read(opts.runId)
    const retryAttempt = await executeAttempt(retryJournal, false, {
      scope: 'checkpoint',
    })
    result = retryAttempt.result
    resumeSummary = mergeResumeSummaries(
      resumeSummary,
      retryAttempt.resumeSummary,
    )
  }

  if (resumeSummary) result = { ...result, resume: resumeSummary }

  ports.progressEmitter.emit({
    type: 'run_done',
    runId: opts.runId,
    workflowName,
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.instanceId !== undefined ? { instanceId: opts.instanceId } : {}),
    ...result,
  })
  return result
}

/**
 * Persist the journal this attempt is authoritative for.
 *
 * The rewrite is a deletion, so the only question that matters is which records
 * this attempt has the standing to delete:
 *
 * - Records it visited (replayed or re-run live) are in `reachedEntries` and always
 *   survive — the live ones already carry the fresh result.
 * - Records at or after an *observed* divergence are provably stale: a re-run
 *   produced a different output, so everything downstream was computed from an input
 *   that no longer exists. They go, whether or not this attempt got that far.
 * - Everything else was simply not visited. That says nothing about validity when the
 *   attempt stopped early (kill, budget exhaustion, a throw escaping the script), so
 *   those records are kept. Deleting them is what made pressing `x` halfway through a
 *   resume permanently drop every checkpoint past the interruption — a 10-agent run
 *   resumed and cancelled at agent 3 came back with a 3-entry journal.
 *
 * A script that ran to its end is the one case where "not visited" does mean "no
 * longer part of this workflow", so a completed attempt may additionally drop the
 * tail that a scope:"all" rerun replaced wholesale.
 */
async function finalizeAttemptJournal(
  ctx: EngineContext,
  scriptRanToCompletion: boolean,
): Promise<void> {
  const state = ctx.resumeState
  if (!state?.journalNeedsRewrite) return
  const discardFrom = scriptRanToCompletion
    ? (state.divergentFrom ?? Number.POSITIVE_INFINITY)
    : (state.observedDivergentFrom ?? Number.POSITIVE_INFINITY)
  const entries = [...state.journalBySeq.entries()]
    .filter(([seq]) => state.reachedEntries.has(seq) || seq < discardFrom)
    .sort(([left], [right]) => left - right)
    .map(([, entry]) => entry)
  // Nothing to delete: every surviving record is already on disk (loaded from it, or
  // appended live), and read() keeps the last record per seq. Rewriting would only
  // re-derive the same file — and on a store without an atomic rewrite that means an
  // unnecessary truncate-then-append window.
  if (entries.length === state.journalBySeq.size) {
    ctx.journal = entries
    return
  }
  const store = ctx.ports.journalStore
  if (store.rewrite) {
    await store.rewrite(ctx.runId, entries)
  } else {
    await store.truncate(ctx.runId)
    for (const entry of entries) await store.append(ctx.runId, entry)
  }
  ctx.journal = entries
}

function mergeResumeSummaries(
  previous: WorkflowResumeSummary | undefined,
  current: WorkflowResumeSummary | undefined,
): WorkflowResumeSummary | undefined {
  if (!previous) return current
  if (!current) return previous
  const stillNotReached = new Set(current.selectorsNotReached)
  return {
    policy: previous.policy,
    replayedCount: previous.replayedCount + current.replayedCount,
    liveCount: previous.liveCount + current.liveCount,
    selectorsNotReached: previous.selectorsNotReached.filter(id =>
      stillNotReached.has(id),
    ),
  }
}

async function resolveSubScript(
  sub: { name?: string; scriptPath?: string; script?: string },
  cwd: string,
  workflowDir: string,
): Promise<string> {
  if (sub.script) return sub.script
  if (sub.scriptPath) return await readFile(sub.scriptPath, 'utf-8')
  if (sub.name) {
    const found = await resolveNamedWorkflow(join(cwd, workflowDir), sub.name)
    if (!found) throw new WorkflowError(`Sub-workflow "${sub.name}" not found`)
    return found.content
  }
  throw new WorkflowError('workflow() requires name or scriptPath')
}
