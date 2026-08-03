import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WORKFLOW_DIR_NAME } from '../constants.js'
import type { HostHandle, WorkflowPorts } from '../ports.js'
import type { JournalEntry, WorkflowRunResult } from '../types.js'
import { BudgetExhaustedError } from './budget.js'
import { createEngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { makeHooks, type SubWorkflowRunner } from './hooks.js'
import { resolveNamedWorkflow } from './namedWorkflows.js'
import { parseScript, type ParsedScript } from './script.js'

export type RunWorkflowOptions = {
  /** Already-resolved script source code. */
  script: string
  args?: unknown
  runId: string
  workflowName?: string
  ports: WorkflowPorts
  host: HostHandle
  signal: AbortSignal
  cwd: string
  budgetTotal: number | null
  /** Concurrency slots for a single run; undefined → DEFAULT_MAX_CONCURRENCY. */
  maxConcurrency?: number
  /** resume: when true, load the existing journal and replay. */
  resume?: boolean
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
  /** Pause before the in-place agent retry; undefined → AGENT_RETRY_BACKOFF_MS. Tests inject 0. */
  retryBackoffMs?: number
}

export async function runWorkflow(
  opts: RunWorkflowOptions,
): Promise<WorkflowRunResult> {
  const { ports } = opts

  let parsed: ParsedScript
  try {
    parsed = parseScript(opts.script)
  } catch (e) {
    const error = (e as Error).message
    ports.progressEmitter.emit({
      type: 'run_done',
      runId: opts.runId,
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
  }

  ports.progressEmitter.emit({
    type: 'run_started',
    runId: opts.runId,
    workflowName,
    meta: parsed.meta,
  })

  // One attempt = fresh context + full script execution. retryEligible marks failures
  // worth an automatic journal-resume: agent-induced script errors (a dead agent's null
  // exploding in script code) are transient once the agent is re-run; WorkflowError
  // (config/caps/parse — deterministic) and BudgetExhaustedError (a fresh context would
  // reset spent and overspend) are not.
  const executeAttempt = async (
    attemptJournal: JournalEntry[],
    invalidated: boolean,
  ): Promise<{ result: WorkflowRunResult; retryEligible: boolean }> => {
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
      ...(opts.retryBackoffMs !== undefined
        ? { retryBackoffMs: opts.retryBackoffMs }
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
    emitTerminalPhaseDone()
    return { result, retryEligible }
  }

  let { result, retryEligible } = await executeAttempt(
    journal,
    journalInvalidated,
  )

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
    ;({ result } = await executeAttempt(retryJournal, false))
  }

  ports.progressEmitter.emit({
    type: 'run_done',
    runId: opts.runId,
    ...result,
  })
  return result
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
