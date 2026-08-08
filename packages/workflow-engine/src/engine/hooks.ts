import { isDeepStrictEqual } from 'node:util'
import {
  AGENT_MAX_RETRIES_BY_REASON,
  MAX_ITEMS_PER_CALL,
  MAX_TOTAL_AGENTS,
} from '../constants.js'
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from '../types.js'
import type { EngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import {
  agentCallKey,
  journalEntryMatches,
  resumePolicySelectsAgent,
} from './journal.js'
import { retryDelayMs } from './retryBackoff.js'
import type { WorkflowHooks } from './script.js'

/** Sub-workflow executor for the workflow() hook (injected by runWorkflow to avoid circular dependencies). */
export type SubWorkflowRunner = (opts: {
  name?: string
  scriptPath?: string
  script?: string
  args?: unknown
}) => Promise<unknown>

type HookProgressInit =
  | { type: 'phase_started'; phase: string }
  | { type: 'phase_done'; phase: string }
  | { type: 'agent_started'; agentId: number; label?: string; phase?: string }
  | {
      type: 'agent_done'
      agentId: number
      label?: string
      phase?: string
      result: AgentRunResult
      execution: 'replayed' | 'live'
    }
  | {
      type: 'agent_progress'
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
    }
  | {
      type: 'agent_retry'
      agentId: number
      label?: string
      phase?: string
      attempt: number
      limit: number
      reason: string
      detail?: string
      delayMs: number
    }
  | { type: 'log'; message: string }

export function makeHooks(
  ctx: EngineContext,
  runSubWorkflow: SubWorkflowRunner,
): WorkflowHooks {
  // All progress events auto-inject runId so the adapter can route them to the corresponding task (multiple concurrent workflows)
  const emit = (init: HookProgressInit): void => {
    ctx.ports.progressEmitter.emit({
      runId: ctx.runId,
      ...init,
    } as ProgressEvent)
  }

  const markJournalDivergence = (
    agentId: number,
    reason: 'identity' | 'output' | 'incomplete',
  ): void => {
    const state = ctx.resumeState
    if (!state) return
    if (state.divergentFrom !== null && state.divergentFrom <= agentId) {
      return
    }
    state.divergentFrom = agentId
    // Separate from divergentFrom, which scope:"all" pre-seeds to 0 to force every
    // call live. Only an *observed* divergence proves the cached suffix is wrong, and
    // that is the one thing allowed to delete records this attempt never visited.
    state.observedDivergentFrom = agentId
    state.journalNeedsRewrite = true
    ctx.journalInvalidated = true
    const discarded = [...state.journalBySeq.keys()].filter(
      seq => seq >= agentId,
    ).length
    // Agent ids are 0-based on every surface that shows them (progress rows,
    // resumePolicy selectors, the cancel input), so the message uses the id itself
    // rather than a 1-based "call #N" the user would then have to translate back.
    const at = `agentId ${agentId} (0-based)`
    const message =
      reason === 'identity'
        ? `journal diverged at ${at} — ${state.replayedCount} cached result(s) replayed, ${discarded} discarded; the rest runs live`
        : reason === 'output'
          ? `rerun output diverged at ${at} — cached suffix discarded; the rest runs live`
          : `journal has no completed call at ${at} — cached suffix discarded; the rest runs live`
    ctx.ports.logger.warn?.(`resume ${ctx.runId}: ${message}`)
    emit({ type: 'log', message })
  }

  const agent: WorkflowHooks['agent'] = async (prompt, opts = {}) => {
    const r = ctx.resources
    if (r.agentCountBox.value >= MAX_TOTAL_AGENTS) {
      throw new WorkflowError(
        `workflow exceeds total agent cap (${MAX_TOTAL_AGENTS})`,
      )
    }

    // Assign a unique id to each agent() call (including journal hits); stamp started/done so the reducer can associate them precisely
    const agentId = r.agentIdSeq.value++

    const params: AgentRunParams = { prompt, ...opts }
    const key = agentCallKey(prompt, params)
    const label = opts.label as string | undefined
    const phase =
      (opts.phase as string | undefined) ?? ctx.currentPhase ?? undefined

    // Resume decisions are serialized, not backend work. A lower selected/dead/incomplete
    // call can change the prompts or control flow of every later call; later decisions wait
    // for that uncertain output before deciding whether their checkpoint is still valid.
    const resumeState = ctx.resumeState
    let priorEntry: JournalEntry | undefined
    let priorEntryMissing = false
    // Two ways this call's resume outcome can be closed out, and they mean opposite
    // things. settleResumeOutcome carries a real result and compares it against the
    // recorded one. abandonResumeOutcome is the early exit — kill, budget exhaustion,
    // a configuration throw — where the call produced no output at all, so there is
    // nothing to compare and nothing to invalidate. Collapsing the two is what used to
    // turn Ctrl-C during a resume into a permanent journal truncation.
    let settleResumeOutcome: ((result: AgentRunResult) => void) | undefined
    let abandonResumeOutcome: (() => void) | undefined
    if (resumeState) {
      resumeState.seenAgentIds.add(agentId)
      const previousDecision = resumeState.decisionTail
      let releaseDecision = (): void => {}
      resumeState.decisionTail = new Promise<void>(resolve => {
        releaseDecision = resolve
      })
      await previousDecision
      await Promise.all([...resumeState.pendingOutcomes])
      try {
        const entry = resumeState.journalBySeq.get(agentId)
        const suffixAlreadyDiverged =
          resumeState.divergentFrom !== null &&
          agentId >= resumeState.divergentFrom
        if (!suffixAlreadyDiverged) {
          if (entry && !journalEntryMatches(entry, agentId, key)) {
            markJournalDivergence(agentId, 'identity')
          } else if (!entry) {
            // A gap before later completed records is an incomplete call. Its output has
            // no trustworthy baseline, so later checkpoints wait and then rerun.
            priorEntryMissing = resumeState.maxJournalSeq > agentId
          } else if (
            entry.result.kind !== 'dead' &&
            !resumePolicySelectsAgent(resumeState.policy, agentId)
          ) {
            ctx.journalIndex++
            resumeState.reachedEntries.set(agentId, entry)
            resumeState.replayedCount++
            emit({
              type: 'agent_done',
              agentId,
              label,
              phase,
              result: entry.result,
              execution: 'replayed',
            })
            return resultToOutput(entry.result)
          } else {
            priorEntry = entry
          }
        }

        if (priorEntry || priorEntryMissing) {
          let resolveOutcome = (): void => {}
          const outcome = new Promise<void>(resolve => {
            resolveOutcome = resolve
          })
          resumeState.pendingOutcomes.add(outcome)
          let settled = false
          const release = (): void => {
            resumeState.pendingOutcomes.delete(outcome)
            resolveOutcome()
          }
          settleResumeOutcome = result => {
            if (settled) return
            settled = true
            if (
              priorEntryMissing ||
              (priorEntry !== undefined &&
                !isDeepStrictEqual(
                  resultToOutput(priorEntry.result),
                  resultToOutput(result),
                ))
            ) {
              markJournalDivergence(
                agentId,
                priorEntryMissing ? 'incomplete' : 'output',
              )
            }
            release()
          }
          abandonResumeOutcome = () => {
            if (settled) return
            settled = true
            // No divergence: the recorded entry is still the newest thing known
            // about this call, and every later checkpoint stays valid too.
            release()
          }
        }
      } finally {
        releaseDecision()
      }
    }

    const finishLiveResult = async (result: AgentRunResult): Promise<void> => {
      emit({
        type: 'agent_done',
        agentId,
        label,
        phase,
        result,
        execution: 'live',
      })
      const entry: JournalEntry = { key, seq: agentId, result }
      const existingIndex = ctx.journal.findIndex(
        journalEntry => journalEntry.seq === agentId,
      )
      if (existingIndex >= 0) ctx.journal[existingIndex] = entry
      else ctx.journal.push(entry)
      if (resumeState) {
        resumeState.liveCount++
        resumeState.reachedEntries.set(agentId, entry)
        resumeState.journalBySeq.set(agentId, entry)
      }
      try {
        await ctx.ports.journalStore.append(ctx.runId, entry)
      } finally {
        settleResumeOutcome?.(result)
        settleResumeOutcome = undefined
        abandonResumeOutcome = undefined
      }
    }

    let release: (() => void) | undefined
    try {
      release = await ctx.resources.semaphore.acquire(ctx.signal)
    } catch {
      // Queued wait during abort: the semaphore already removed the waiter and did not consume a permit
      abandonResumeOutcome?.()
      throw new WorkflowAbortedError()
    }
    try {
      if (ctx.signal.aborted) throw new WorkflowAbortedError()
      // Budget check inside the semaphore critical section: a queued waiter sees the latest spent when woken,
      // otherwise N waiters enqueued while spent=0 all pass the check and overspend on wake-up without re-check.
      // Journal-hit path does not charge budget and needs no check.
      r.budget.assertCanSpend()

      const pending = ctx.ports.taskRegistrar.pendingAction(ctx.runId)
      if (pending?.kind === 'skip') {
        const result: AgentRunResult = { kind: 'skipped' }
        await finishLiveResult(result)
        return null
      }

      ctx.resources.agentCountBox.value++
      emit({ type: 'agent_started', agentId, label, phase })
      const registry = ctx.ports.agentAdapterRegistry
      // onProgress closure: the backend loop accumulates token/tool counts -> emits an agent_progress event (carrying agentId for association)
      const onProgress = (update: AgentProgressUpdate): void => {
        emit({ type: 'agent_progress', agentId, label, phase, ...update })
      }
      // Inject agent-level AbortController register/unregister: the backend creates the controller then calls
      // registerAgentAbort to inject ports-layer bindings; service.kill(runId, agentId) uses this to
      // precisely abort a single agent. When the registry is absent (agentRunner fallback path), there is no backend middle layer,
      // and agentAbortControllers at the ports layer is always empty — single-agent kill degrades to a no-op on this path.
      const adapterCtx = registry
        ? {
            host: ctx.host,
            signal: ctx.signal,
            runId: ctx.runId,
            agentId,
            onProgress,
            ...(ctx.ports.taskRegistrar.registerAgentAbort
              ? {
                  registerAgentAbort: (
                    id: number,
                    ac: AbortController,
                  ): void => {
                    ctx.ports.taskRegistrar.registerAgentAbort?.(
                      ctx.runId,
                      id,
                      ac,
                    )
                  },
                }
              : {}),
            ...(ctx.ports.taskRegistrar.unregisterAgentAbort
              ? {
                  unregisterAgentAbort: (id: number): void => {
                    ctx.ports.taskRegistrar.unregisterAgentAbort?.(
                      ctx.runId,
                      id,
                    )
                  },
                }
              : {}),
          }
        : null
      // resolve is outside the try: configuration errors (e.g. AdapterNotFoundError) propagate directly without retry —
      // this is a workflow configuration problem, not a transient backend failure; retrying is meaningless and would mask the bug.
      const adapter = registry ? registry.resolve(params) : null
      const invokeBackend = (): Promise<AgentRunResult> =>
        adapter
          ? adapter.run(params, adapterCtx!)
          : ctx.ports.agentRunner.runAgentToResult(params, ctx.host)

      // Auto-retry on failure: dead (terminal API error the transport already gave up on) and
      // non-abort throws both get up to ctx.agentMaxRetries in-place retries; WorkflowAbortedError
      // (kill) is never retried — it is the user's intent.
      // Deterministic failures (retryable:false, e.g. prompt-too-long) skip retrying entirely: the
      // identical call cannot succeed, and re-issuing it only doubles the damage. Per-cause budgets
      // (AGENT_MAX_RETRIES_BY_REASON) shrink the count where a retry means re-running a whole agent
      // that already spent its tokens.
      // Each retry waits an exponentially growing, jittered, abort-aware backoff: the dominant
      // transient failures are overload/stream drops, and an immediate identical call mostly lands
      // on the same congested endpoint — worse, a whole parallel() batch retries in lockstep.
      // Every retry emits agent_retry, NOT a second agent_started: the agent is still this run's
      // agent #N and its elapsed clock must keep running across the whole retry chain. Re-emitting
      // agent_started would reset startedAt in the store, so an agent 14s into its third attempt
      // would render as "just started" — worse than the silent version it was meant to fix.
      // agent_started stays reserved for a genuinely new attempt of agent #N (the workflow-level
      // journal resume, which builds a fresh context and reuses ids from 0).
      // If the last attempt still fails: dead stays dead; a throw degrades to dead (one agent must
      // not take down the workflow).
      // Journal/budget invariants across retries: nothing that feeds agentCallKey (prompt/params) is
      // touched, so resume replay stays positionally identical; budget is charged once at the final
      // ok (dead never calls addOutputTokens) and the journal gets exactly one append, for the final result.
      // dead.reason is passed through to the log: no-structured-output (the agent's final text block did not produce plain-object JSON)
      // is a high-frequency cause of death; logging detail lets you immediately see what the agent last said.
      // detail is type-checked defensively: old journals or third-party adapters may write non-strings (corrupted data),
      // and calling .slice directly would throw a TypeError that pierces the logging path.
      const backoffBeforeRetry = async (ms: number): Promise<void> => {
        if (ms > 0 && !ctx.signal.aborted) {
          await new Promise<void>(resolve => {
            const onAbort = (): void => {
              clearTimeout(timer)
              resolve()
            }
            const timer = setTimeout(() => {
              ctx.signal.removeEventListener('abort', onAbort)
              resolve()
            }, ms)
            ctx.signal.addEventListener('abort', onAbort, { once: true })
          })
        }
        if (ctx.signal.aborted) throw new WorkflowAbortedError()
      }
      const agentName = label ?? `#${agentId}`
      const deadSummary = (dead: AgentRunResult & { kind: 'dead' }): string => {
        const detailStr = typeof dead.detail === 'string' ? dead.detail : ''
        return (
          'returned dead' +
          (dead.reason ? ` (${dead.reason})` : '') +
          (detailStr ? `: ${detailStr.slice(0, 150)}` : '')
        )
      }
      const retryBudgetFor = (
        dead: AgentRunResult & { kind: 'dead' },
      ): number =>
        Math.min(
          ctx.agentMaxRetries,
          (dead.reason
            ? AGENT_MAX_RETRIES_BY_REASON[dead.reason]
            : undefined) ?? ctx.agentMaxRetries,
        )

      let result: AgentRunResult
      let retries = 0
      for (;;) {
        // Why the failure/limit/reason locals instead of retrying inside each branch: the dead
        // path and the throw path share one "announce -> wait -> re-invoke" tail, and duplicating
        // that tail is how the previous version ended up emitting different things on the two paths.
        let failure: string
        let limit: number
        let reason: string
        let detail: string | undefined
        try {
          result = await invokeBackend()
          if (result.kind !== 'dead') break
          if (result.retryable === false) {
            ctx.ports.logger.warn?.(
              `agent "${agentName}" ${deadSummary(result)}; deterministic failure, not retrying`,
            )
            break
          }
          limit = retryBudgetFor(result)
          if (retries >= limit) {
            ctx.ports.logger.warn?.(
              `agent "${agentName}" ${deadSummary(result)}; no retries left (${retries}/${limit})`,
            )
            break
          }
          failure = deadSummary(result)
          reason = result.reason ?? 'unknown'
          detail =
            typeof result.detail === 'string'
              ? result.detail.slice(0, 150)
              : undefined
        } catch (e) {
          if (e instanceof WorkflowAbortedError) throw e
          // An abort that surfaced as some other error (adapter swallowed the class, fetch
          // rejected with its own AbortError) must not burn retries against a killed run.
          if (ctx.signal.aborted) throw new WorkflowAbortedError()
          const eMsg = e instanceof Error ? e.message : String(e)
          limit = ctx.agentMaxRetries
          if (retries >= limit) {
            // Out of retries and still throwing: degrade to dead so the workflow keeps going
            // (hooks.agent returns null) instead of letting the throw escape into the script.
            ctx.ports.logger.warn?.(
              `agent "${agentName}" threw (${eMsg}); no retries left (${retries}/${limit})`,
            )
            result = { kind: 'dead', reason: 'runagent-threw', detail: eMsg }
            break
          }
          failure = `threw (${eMsg})`
          reason = 'threw'
          detail = eMsg.slice(0, 150)
        }
        retries++
        const delayMs = retryDelayMs(ctx.retryBackoffMs, retries)
        ctx.ports.logger.warn?.(
          `agent "${agentName}" retrying (${retries}/${limit}) after ${failure}`,
        )
        // Announced before the wait, so a consumer can show "retry 2/3, backing off"
        // for the seconds the engine is deliberately idle rather than a frozen row.
        emit({
          type: 'agent_retry',
          agentId,
          label,
          phase,
          attempt: retries,
          limit,
          reason,
          ...(detail ? { detail } : {}),
          delayMs,
        })
        await backoffBeforeRetry(delayMs)
      }
      if (result.kind === 'ok') {
        ctx.resources.budget.addOutputTokens(result.usage.outputTokens)
      }
      await finishLiveResult(result)
      return resultToOutput(result)
    } finally {
      // Reached only when the call left without a result (kill, budget exhaustion,
      // an adapter configuration throw). Releasing the waiters is required — later
      // resume decisions block on this outcome — but the release must not claim the
      // cached suffix is stale, because nothing was produced to contradict it.
      abandonResumeOutcome?.()
      release?.()
    }
  }

  const parallel: WorkflowHooks['parallel'] = async thunks => {
    if (thunks.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `parallel exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      thunks.map(async (t, i) => {
        try {
          return await t()
        } catch (e) {
          // Abort must propagate: swallowing it to null would let a killed run keep
          // executing the script with the remaining thunks' nulls (run never ends killed).
          if (e instanceof WorkflowAbortedError) throw e
          // The "null on error" contract is unchanged, but it should log — otherwise the workflow author cannot locate why an agent failed
          ctx.ports.logger.warn?.(
            `parallel thunk #${i} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const pipeline: WorkflowHooks['pipeline'] = async <T, R>(
    items: readonly T[],
    ...stages: Array<
      (prev: unknown, item: T, index: number) => Promise<unknown>
    >
  ): Promise<Array<R | null>> => {
    if (items.length > MAX_ITEMS_PER_CALL) {
      throw new WorkflowError(
        `pipeline exceeds the per-call items cap (${MAX_ITEMS_PER_CALL})`,
      )
    }
    return Promise.all(
      items.map(async (item, index): Promise<R | null> => {
        try {
          let prev: unknown = item
          for (const stage of stages) {
            prev = await stage(prev, item, index)
          }
          return prev as R
        } catch (e) {
          // Abort must propagate (same reasoning as parallel): a killed run has to end killed.
          if (e instanceof WorkflowAbortedError) throw e
          ctx.ports.logger.warn?.(
            `pipeline item #${index} failed: ${(e as Error).message}`,
          )
          return null
        }
      }),
    )
  }

  const phase: WorkflowHooks['phase'] = title => {
    if (ctx.currentPhase) {
      emit({ type: 'phase_done', phase: ctx.currentPhase })
    }
    ctx.currentPhase = title
    emit({ type: 'phase_started', phase: title })
  }

  const log: WorkflowHooks['log'] = message => {
    emit({ type: 'log', message })
  }

  const workflow: WorkflowHooks['workflow'] = async (nameOrRef, args) => {
    if (ctx.resources.depth >= 1) {
      throw new WorkflowError('workflow() nesting allows only one level')
    }
    const sub: Parameters<SubWorkflowRunner>[0] =
      typeof nameOrRef === 'string'
        ? { name: nameOrRef }
        : { scriptPath: nameOrRef.scriptPath }
    return runSubWorkflow({ ...sub, args })
  }

  return { agent, parallel, pipeline, phase, log, workflow }
}

function resultToOutput(result: AgentRunResult): unknown {
  return result.kind === 'ok' ? result.output : null
}
