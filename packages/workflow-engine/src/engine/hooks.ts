import { MAX_ITEMS_PER_CALL, MAX_TOTAL_AGENTS } from '../constants.js'
import type {
  AgentProgressUpdate,
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from '../types.js'
import type { EngineContext } from './context.js'
import { WorkflowAbortedError, WorkflowError } from './errors.js'
import { agentCallKey } from './journal.js'
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
    }
  | {
      type: 'agent_progress'
      agentId: number
      label?: string
      phase?: string
      tokenCount: number
      toolCount: number
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

    // Journal hit -> return cached result directly. A dead entry is a recorded
    // failure, not a result: consume its slot positionally and fall through to a
    // live re-run — resume exists to retry failures, not to replay them.
    let replayDeadIdx: number | null = null
    if (!ctx.journalInvalidated && ctx.journalIndex < ctx.journal.length) {
      const entry = ctx.journal[ctx.journalIndex]!
      if (entry.key === key) {
        if (entry.result.kind === 'dead') {
          replayDeadIdx = ctx.journalIndex
          ctx.journalIndex++
        } else {
          ctx.journalIndex++
          emit({
            type: 'agent_done',
            agentId,
            label,
            phase,
            result: entry.result,
          })
          return resultToOutput(entry.result)
        }
      } else {
        // Divergence: discard subsequent journal entries; everything from here on runs live
        ctx.journalInvalidated = true
        ctx.journal = ctx.journal.slice(0, ctx.journalIndex)
        await ctx.ports.journalStore.truncate(ctx.runId)
      }
    }

    let release: () => void
    try {
      release = await ctx.resources.semaphore.acquire(ctx.signal)
    } catch {
      // Queued wait during abort: the semaphore already removed the waiter and did not consume a permit
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
        emit({ type: 'agent_done', agentId, label, phase, result })
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

      // Auto-retry once on failure: dead (terminal API error after retries) or a non-abort throw
      // both get one retry chance; WorkflowAbortedError (kill) is not retried — it is the user's intent.
      // Deterministic failures (retryable:false, e.g. prompt-too-long) skip the retry: the identical
      // call cannot succeed, and re-issuing it only doubles the damage.
      // The retry waits retryBackoffMs first (abort-aware): the dominant transient failures are
      // overload/stream drops, and an immediate identical call mostly lands on the same congested endpoint.
      // If retry still fails: dead stays dead; a throw degrades to dead (one agent must not take down the workflow).
      // budget is not double-charged: dead does not call addOutputTokens; retry-ok charges once (at the final ok).
      // dead.reason is passed through to the log: no-structured-output (the agent's final text block did not produce plain-object JSON)
      // is a high-frequency cause of death; logging detail lets you immediately see what the agent last said.
      // detail is wrapped with String() defensively: old journals or third-party adapters may write non-strings (corrupted data),
      // and calling .slice directly would throw a TypeError that pierces the logging path.
      const backoffBeforeRetry = async (): Promise<void> => {
        const ms = ctx.retryBackoffMs
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
      const deadSummary = (
        result: AgentRunResult & { kind: 'dead' },
      ): string => {
        const detailStr = typeof result.detail === 'string' ? result.detail : ''
        return (
          `agent "${label ?? `#${agentId}`}" returned dead` +
          (result.reason ? ` (${result.reason})` : '') +
          (detailStr ? `: ${detailStr.slice(0, 150)}` : '')
        )
      }
      let result: AgentRunResult
      try {
        result = await invokeBackend()
        if (result.kind === 'dead') {
          if (result.retryable === false) {
            ctx.ports.logger.warn?.(
              `${deadSummary(result)}; deterministic failure, not retrying`,
            )
          } else {
            ctx.ports.logger.warn?.(`${deadSummary(result)}; retrying once`)
            await backoffBeforeRetry()
            result = await invokeBackend()
          }
        }
      } catch (e) {
        if (e instanceof WorkflowAbortedError) throw e
        const eMsg = e instanceof Error ? e.message : String(e)
        ctx.ports.logger.warn?.(
          `agent "${label ?? `#${agentId}`}" threw (${eMsg}); retrying once`,
        )
        try {
          await backoffBeforeRetry()
          result = await invokeBackend()
        } catch (e2) {
          if (e2 instanceof WorkflowAbortedError) throw e2
          // Retry still threw: degrade to dead (keep the workflow going; hooks.agent returns null)
          result = {
            kind: 'dead',
            reason: 'runagent-threw',
            detail: e2 instanceof Error ? e2.message : String(e2),
          }
        }
      }
      if (result.kind === 'ok') {
        ctx.resources.budget.addOutputTokens(result.usage.outputTokens)
      }
      emit({ type: 'agent_done', agentId, label, phase, result })

      const entry: JournalEntry = { key, seq: agentId, result }
      if (replayDeadIdx !== null) {
        // Re-run of a dead journal entry: replace the slot in place (its index was
        // already consumed, so pushing would desync positional replay for the
        // remaining entries). The store append reuses the same seq; read()'s
        // keep-last dedupe makes the fresh result supersede the recorded failure.
        ctx.journal[replayDeadIdx] = entry
      } else {
        // Key point: push order = completion order (not call order); read() already re-sorts by seq,
        // so during resume the call order aligns with the journal order and the key index stays stable.
        ctx.journal.push(entry)
        ctx.journalIndex++
      }
      await ctx.ports.journalStore.append(ctx.runId, entry)
      return resultToOutput(result)
    } finally {
      release()
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
