import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { z } from 'zod/v4'
import {
  DEFAULT_MAX_CONCURRENCY,
  MAX_CONCURRENCY_CAP,
  WORKFLOW_DIR_NAME,
  WORKFLOW_RUNS_DIR,
  WORKFLOW_TOOL_NAME,
} from '../constants.js'
import { isSelectiveResumePolicy } from '../engine/journal.js'
import { resolveNamedWorkflow } from '../engine/namedWorkflows.js'
import { runWorkflow } from '../engine/runWorkflow.js'
import { parseScript } from '../engine/script.js'
import { containsPath, sanitizeWorkflowName } from '../engine/paths.js'
import {
  isScriptChanged,
  recordScriptHash,
  workflowRunDir,
} from '../engine/scriptHash.js'
import {
  scopeWorkflowPortsToTaskInstance,
  type TaskRegistration,
  type WorkflowAgentStatusSnapshot,
  type WorkflowPorts,
  type WorkflowTaskInstanceId,
} from '../ports.js'
import type { WorkflowRunResult } from '../types.js'
import {
  workflowInputSchema,
  type WorkflowInput,
  type WorkflowRunInput,
} from './schema.js'
import { persistInlineScript } from './persistInline.js'

/** Self-contained tool descriptor (core wiring wraps it with buildTool). Zero core-layer dependencies. */
export type WorkflowToolDescriptor = {
  name: string
  inputSchema: z.ZodType<WorkflowInput>
  isEnabled: () => boolean
  isReadOnly: (input: WorkflowInput) => boolean
  description: () => Promise<string>
  prompt: () => Promise<string>
  renderToolUseMessage: (input: Partial<WorkflowInput>) => string
  call: (
    input: WorkflowInput,
    context: unknown,
    canUseTool: unknown,
    parentMessage: unknown,
    onProgress?: unknown,
  ) => Promise<{ data: { output: string } }>
  mapToolResultToToolResultBlockParam: (
    data: { output: string },
    toolUseId: string,
  ) => {
    tool_use_id: string
    type: 'tool_result'
    content: Array<{ type: 'text'; text: string }>
  }
}

/**
 * Concurrency tiers offered to the user when the model must ask before changing the value.
 * Derived from the *effective* default so the recommended option is the one the run would
 * get by omitting the input — offering a stale "6 (Recommended)" against a host default of
 * 12 trains the model to interrupt the user for the value it should have used silently.
 */
function concurrencyTiers(effectiveDefault: number): number[] {
  const tiers = [
    Math.max(1, Math.floor(effectiveDefault / 2)),
    effectiveDefault,
    Math.min(MAX_CONCURRENCY_CAP, effectiveDefault * 2),
  ]
  return [...new Set(tiers)].sort((a, b) => a - b)
}

/**
 * Built per descriptor rather than frozen at module load: the effective default can be
 * overridden by the host (OCC_WORKFLOW_MAX_CONCURRENCY), and a prompt quoting the compiled-in
 * constant would describe a run behaviour that no longer exists on this machine.
 */
function buildWorkflowToolPrompt(opts: {
  workflowDir: string
  defaultMaxConcurrency: number
}): string {
  const d = opts.defaultMaxConcurrency
  return `Use the Workflow tool to execute, inspect, or cancel workflow runs. operation "run" is the backward-compatible default; its script runs in the background and returns a run_id immediately. Use operation "status" (alias "query") with runId to inspect live or persisted terminal progress. Use operation "cancel" with runId to cancel the whole run, or add agentId to cancel exactly one active child agent.

For run, provide the script inline via "script", or reference a named workflow via "name" (resolved from ${opts.workflowDir}/), or an existing file via "scriptPath". Pass "args" as a real JSON value (object/array/string), not a stringified string. Do not send script fields with status/query/cancel.

Use "resumeFromRunId" to resume a prior run. Omit "resumePolicy" (or use scope "checkpoint") for the existing behavior: completed calls replay and dead/incomplete calls rerun. scope "all" reruns every call. scope "range" and "agents" rerun only selected completed calls while replaying the rest. Agent IDs are the global 0-based sequence shown in workflow progress, including nested workflows.

Selecting a call for rerun is not a promise that only that call reruns. A cached result is replayed only while it still matches what the journal recorded, so if a selected agent returns anything different from last time — and a re-prompted model usually does — every checkpoint after it is discarded and re-runs live. Treat "range"/"agents" as "rerun from here, cheaply if nothing changed", and expect a full-cost tail when the rerun's output differs. Selecting the LAST calls of a run is the case that reliably stays cheap.

Concurrency: the effective default is ${d} (hard ceiling ${MAX_CONCURRENCY_CAP}). OMIT maxConcurrency to use it. To set maxConcurrency to ANY other value, you MUST first ask the user via AskUserQuestion — propose ${concurrencyTiers(d).join(' / ')} (or other tiers matching the fan-out width) with ${d} marked "(Recommended)". The ONLY exception: the user has ALREADY specified a concurrency number in this session ("use 12", "maxConcurrency 9") — then honor it without re-asking. Never silently change concurrency just because the workflow fans out; ${d} is the recommended default.

Script execution model (common pitfalls — getting these wrong is the #1 cause of script errors): the script is the body of \`new AsyncFunction\` — NOT an ESM module, and TypeScript is NOT transpiled. Therefore:
- Do NOT use \`import\` — \`agent\`, \`parallel\`, \`pipeline\`, \`phase\`, \`log\`, \`workflow\`, \`args\`, and \`budget\` are injected as parameters; reference them directly.
- Do NOT use TS type annotations, \`interface\`, \`enum\`, \`as\`, or generics — the engine does not transpile, so even a .ts file with type syntax fails to parse.
- Keep EXACTLY ONE \`export const meta = {...}\` (plain literal) and remove every other \`export\` / \`export default\`.
- Return the result with a top-level \`return\`.
Prefer .js / .mjs. See /ultracode for the full playbook and quality patterns.`
}

export type WorkflowToolOptions = {
  workflowDir?: string
  workflowRunsDir?: string
  /**
   * Default concurrency when the caller omits maxConcurrency (undefined → DEFAULT_MAX_CONCURRENCY;
   * still clamped by MAX_CONCURRENCY_CAP downstream). The host resolves it from
   * OCC_WORKFLOW_MAX_CONCURRENCY and passes it in — this package reads no process.env.
   */
  defaultMaxConcurrency?: number
}

export function createWorkflowTool(
  ports: WorkflowPorts,
  options: WorkflowToolOptions = {},
): WorkflowToolDescriptor {
  return {
    name: WORKFLOW_TOOL_NAME,
    inputSchema: workflowInputSchema,
    // No per-session runtime opt-in gate here: the "ultracode is on for the
    // session" signal is injected by the harness (claude.ai/client), not held
    // in any repo state. This tool is compiled in/out via feature('WORKFLOW_SCRIPTS')
    // in src/tools.ts; beyond that it is always enabled when present.
    isEnabled: () => true,
    isReadOnly: input =>
      input.operation === 'status' || input.operation === 'query',

    async description() {
      return 'Execute, inspect, or cancel workflow runs that orchestrate multiple subagents'
    },

    async prompt() {
      return buildWorkflowToolPrompt({
        workflowDir: options.workflowDir ?? WORKFLOW_DIR_NAME,
        defaultMaxConcurrency:
          options.defaultMaxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      })
    },

    renderToolUseMessage(input) {
      if (input.operation === 'status' || input.operation === 'query')
        return `Workflow status: ${input.runId ?? 'unknown'}`
      if (input.operation === 'cancel')
        return input.agentId === undefined
          ? `Workflow cancel: ${input.runId ?? 'unknown'}`
          : `Workflow cancel agent ${input.agentId}: ${input.runId ?? 'unknown'}`
      const runInput = input as Partial<WorkflowRunInput>
      if (runInput.resumeFromRunId)
        return `Workflow resume: ${runInput.resumeFromRunId}`
      const id =
        runInput.name ??
        runInput.scriptPath ??
        (runInput.script ? 'inline' : 'unknown')
      return `Workflow: ${id}`
    },

    async call(input, context, canUseTool, parentMessage) {
      if (input.operation === 'status' || input.operation === 'query') {
        return queryWorkflowRun(ports, input.runId)
      }
      if (input.operation === 'cancel') {
        return cancelWorkflowRun(ports, input.runId, input.agentId)
      }

      // The strict schema guarantees the remaining variant is run. The explicit
      // local keeps TypeScript from widening around the optional default operation.
      const runInput = input as WorkflowRunInput
      const host = ports.hostFactory({ context, canUseTool, parentMessage })
      if (runInput.resumeFromRunId) {
        const active = ports.taskRegistrar.getActive?.(runInput.resumeFromRunId)
        if (active) return existingRegistrationResult(active)
      }

      // Resolve the script source
      let script: string
      let workflowFile: string | undefined
      try {
        const resolved = await resolveScriptSource(
          runInput,
          host.cwd,
          options.workflowDir ?? WORKFLOW_DIR_NAME,
        )
        script = resolved.script
        workflowFile = resolved.workflowFile
      } catch (e) {
        return { data: { output: `Error: ${(e as Error).message}` } }
      }

      // Quick validation (meta + syntax): on failure return an error to the model directly, do not enter the background
      try {
        parseScript(script)
      } catch (e) {
        return {
          data: {
            output: `Error: script validation failed: ${(e as Error).message}`,
          },
        }
      }

      // Read-only hash comparison. Recording happens further down, only if this call
      // is the one that wins registration — see the comment at that write.
      const selective =
        runInput.resumePolicy !== undefined &&
        isSelectiveResumePolicy(runInput.resumePolicy)
      let scriptChanged = false
      if (runInput.resumeFromRunId) {
        try {
          scriptChanged = await isScriptChanged({
            script,
            runId: runInput.resumeFromRunId,
            cwd: host.cwd,
            workflowRunsDir: options.workflowRunsDir ?? WORKFLOW_RUNS_DIR,
          })
          if (scriptChanged && selective) {
            return {
              data: {
                output:
                  'Error: selective resume requires an unchanged workflow script; use resumePolicy scope "all" to rerun the changed script',
              },
            }
          }
        } catch (error) {
          if (selective) {
            return {
              data: {
                output: `Error: selective resume could not verify the prior script hash: ${(error as Error).message}`,
              },
            }
          }
          // A resume without trustworthy hash state must not replay checkpoints
          // from a script we can no longer prove is identical.
          scriptChanged = true
          ports.logger.warn?.(
            `workflow script hash check failed: ${(error as Error).message}`,
          )
        }
      }

      const workflowName = runInput.name ?? runInput.title ?? 'workflow'
      const registration = ports.taskRegistrar.register(
        {
          workflowName,
          ...(workflowFile ? { workflowFile } : {}),
          ...(runInput.description ? { summary: runInput.description } : {}),
          ...(host.toolUseId ? { toolUseId: host.toolUseId } : {}),
          ...(runInput.resumeFromRunId
            ? { runId: runInput.resumeFromRunId }
            : {}),
        },
        host.handle,
      )
      const { runId, signal, instanceId } = registration
      if (registration.disposition === 'existing') {
        return existingRegistrationResult(registration)
      }

      // Inline entry: persist the script to the run directory and return a reusable path (the
      // inline -> persist -> edit -> resubmit-as-scriptPath iteration loop promised by the ultracode skill).
      // On write failure degrade to a placeholder + warn, do not abort the run (script is already in memory).
      if (!workflowFile && runInput.script) {
        try {
          workflowFile = await persistInlineScript(
            runInput.script,
            runId,
            host.cwd,
            options.workflowRunsDir,
          )
        } catch (e) {
          ports.logger.warn?.(
            `inline script persist failed: ${(e as Error).message}`,
          )
        }
      }

      // Recorded only now, past the single-flight gate: two concurrent resumes both
      // reach the hash comparison, but only one gets disposition 'created' and only
      // that one's script actually runs. Writing before the gate let the loser stamp
      // the run with a script that never executed, so the winner's own checkpoints
      // then failed the next resume's identity check.
      //
      // A selective resume that got here is by definition unchanged, so re-recording
      // the same bytes is a no-op — but it still must not run when the run was
      // refused above, which is why that path returns early.
      try {
        await recordScriptHash({
          script,
          runId,
          cwd: host.cwd,
          workflowRunsDir: options.workflowRunsDir ?? WORKFLOW_RUNS_DIR,
        })
      } catch (error) {
        ports.logger.warn?.(
          `workflow script hash persistence failed: ${(error as Error).message}`,
        )
      }

      // An explicit input always wins; the host-supplied default only fills the omitted case
      // (undefined leaves the engine's DEFAULT_MAX_CONCURRENCY in charge).
      const runConcurrency =
        runInput.maxConcurrency ?? options.defaultMaxConcurrency

      // Detached execution. The scoped port drops stale-generation progress and
      // carries the instance token into agent-controller cleanup.
      const runPorts = scopeWorkflowPortsToTaskInstance(
        ports,
        runId,
        instanceId,
      )
      void settleDetachedRun(
        runWorkflow({
          script,
          ...(runInput.args !== undefined
            ? { args: normalizeArgs(runInput.args) }
            : {}),
          runId,
          workflowName,
          ...(registration.taskId ? { taskId: registration.taskId } : {}),
          ...(instanceId !== undefined ? { instanceId } : {}),
          ports: runPorts,
          host: host.handle,
          signal,
          cwd: host.cwd,
          budgetTotal: host.budgetTotal,
          ...(runConcurrency !== undefined
            ? { maxConcurrency: runConcurrency }
            : {}),
          ...(runInput.resumeFromRunId
            ? {
                resume: true,
                scriptChanged,
                ...(runInput.resumePolicy
                  ? { resumePolicy: runInput.resumePolicy }
                  : {}),
              }
            : {}),
          ...(options.workflowDir ? { workflowDir: options.workflowDir } : {}),
        }),
        ports,
        runPorts,
        runId,
        workflowName,
        registration.taskId,
        instanceId,
      ).catch(error => {
        // Terminal safety net. settleDetachedRun already handles every failure it
        // can attribute to the run; anything reaching here failed while *reporting*
        // one (the registrar's own emit/fail throwing), and this promise is detached
        // — without the catch it becomes an unhandled rejection that can take the
        // whole process down under --unhandled-rejections=throw.
        ports.logger.warn?.(
          `workflow ${runId} settlement failed: ${(error as Error).message}`,
        )
      })

      const scriptPath = workflowFile ?? `<inline run ${runId}>`
      // Hand back the run directory, not just the id. The journal and the
      // terminal state.json live here and survive both the background task's
      // eviction from AppState and the session itself — without the path the
      // only way to diagnose a finished run is to guess where it landed.
      const runDir = workflowRunDir(
        host.cwd,
        options.workflowRunsDir ?? WORKFLOW_RUNS_DIR,
        runId,
      )
      return {
        data: {
          output: [
            'Workflow started (running in the background).',
            `run_id: ${runId}`,
            ...(registration.taskId && registration.taskId !== runId
              ? [`task_id: ${registration.taskId}`]
              : []),
            `workflow: ${workflowName}`,
            `script: ${scriptPath}`,
            `run_dir: ${runDir}`,
            '',
            'You will be notified on completion. Use /workflows to view live progress.',
            `To inspect the finished run, Read ${join(runDir, 'journal.jsonl')} (one record per agent() call, with its actual return value) or ${join(runDir, 'state.json')} (terminal per-agent status).`,
          ].join('\n'),
        },
      }
    },

    mapToolResultToToolResultBlockParam(data, toolUseId) {
      return {
        tool_use_id: toolUseId,
        type: 'tool_result',
        content: [{ type: 'text', text: data.output }],
      }
    },
  }
}

type ToolCallResult = { data: { output: string } }

async function queryWorkflowRun(
  ports: WorkflowPorts,
  runId: string,
): Promise<ToolCallResult> {
  const active = ports.taskRegistrar.getActive?.(runId)
  const run = await ports.runStatusReader?.getRun(runId)
  if (!run && !active) {
    return jsonResult({
      operation: 'status',
      run_id: runId,
      found: false,
      ...(ports.runStatusReader
        ? { message: 'Workflow run not found.' }
        : { message: 'This host does not provide workflow status lookup.' }),
    })
  }

  const agents = run?.agents ?? []
  const taskId = active?.taskId ?? run?.taskId
  const instanceId = active?.instanceId ?? run?.instanceId
  return jsonResult({
    operation: 'status',
    run_id: runId,
    found: true,
    ...(taskId || instanceId !== undefined
      ? {
          wrapper: {
            active: active !== undefined,
            ...(taskId ? { task_id: taskId } : {}),
            ...(instanceId !== undefined ? { instance_id: instanceId } : {}),
          },
        }
      : {}),
    status: run?.status ?? 'starting',
    workflow: run?.workflowName ?? active?.workflowName ?? 'workflow',
    phase: run?.currentPhase ?? null,
    totals: workflowTotals(agents),
    agents: agents.map(formatAgentStatus),
    updated_at: run?.updatedAt ?? null,
    ...(run?.status !== 'running' && run?.returnValue !== undefined
      ? { return_value: formatValue(run.returnValue) }
      : {}),
    ...(run?.status !== 'running' && run?.error !== undefined
      ? { error: bounded(run.error, 1_000) }
      : {}),
    ...((run?.runDir ?? active?.runDir)
      ? { run_dir: run?.runDir ?? active?.runDir }
      : {}),
  })
}

async function cancelWorkflowRun(
  ports: WorkflowPorts,
  runId: string,
  agentId: number | undefined,
): Promise<ToolCallResult> {
  const active = ports.taskRegistrar.getActive?.(runId)
  if (agentId !== undefined) {
    // Two different answers used to collapse into `hit: false`. "This host cannot
    // cancel individual agents" is a capability gap the model should route around
    // (cancel the whole run instead); "no such live agent" means the id was wrong or
    // the agent already finished, and retrying with a different id may well work.
    const supported = ports.taskRegistrar.killAgent !== undefined
    const hit = supported && ports.taskRegistrar.killAgent!(runId, agentId)
    return jsonResult({
      operation: 'cancel',
      target: 'agent',
      run_id: runId,
      agent_id: agentId,
      supported,
      hit,
      message: !supported
        ? 'This host does not support cancelling a single child agent; cancel the whole run by omitting agentId.'
        : hit
          ? 'Exact child agent cancellation requested.'
          : 'No active child agent matched this runId and agentId (already finished, or the run is not active).',
      ...(active?.taskId ? { task_id: active.taskId } : {}),
      ...(active?.instanceId !== undefined
        ? { instance_id: active.instanceId }
        : {}),
    })
  }

  const killed = await ports.taskRegistrar.kill(runId)
  const hit = killed === true || (killed === undefined && active !== undefined)
  return jsonResult({
    operation: 'cancel',
    target: 'run',
    run_id: runId,
    hit,
    message: hit
      ? 'Workflow run cancellation requested.'
      : 'No active workflow run matched this runId.',
    ...(active?.taskId ? { task_id: active.taskId } : {}),
    ...(active?.instanceId !== undefined
      ? { instance_id: active.instanceId }
      : {}),
  })
}

function agentExecution(
  agent: WorkflowAgentStatusSnapshot,
): 'live' | 'replayed' {
  return (
    agent.execution ?? (agent.startedAt === undefined ? 'replayed' : 'live')
  )
}

function workflowTotals(agents: WorkflowAgentStatusSnapshot[]): object {
  let tokenCount = 0
  let toolCount = 0
  let runningCount = 0
  let doneCount = 0
  let replayedCount = 0
  let liveCount = 0
  for (const agent of agents) {
    tokenCount += agent.tokenCount ?? 0
    toolCount += agent.toolCount ?? 0
    if (agent.status === 'running') runningCount++
    else doneCount++
    if (agentExecution(agent) === 'replayed') replayedCount++
    else liveCount++
  }
  return {
    token_count: tokenCount,
    tool_count: toolCount,
    agent_count: agents.length,
    running_count: runningCount,
    done_count: doneCount,
    replayed_count: replayedCount,
    live_count: liveCount,
  }
}

function formatAgentStatus(agent: WorkflowAgentStatusSnapshot): object {
  return {
    id: agent.id,
    ...(agent.label ? { label: agent.label } : {}),
    ...(agent.phase ? { phase: agent.phase } : {}),
    status: agent.status,
    execution: agentExecution(agent),
    ...(agent.resultKind ? { result: agent.resultKind } : {}),
    retry: {
      count: agent.retryCount ?? 0,
      ...(agent.retryLimit !== undefined ? { limit: agent.retryLimit } : {}),
      ...(agent.lastFailureReason ? { reason: agent.lastFailureReason } : {}),
      ...(agent.lastFailureDetail
        ? { detail: bounded(agent.lastFailureDetail, 300) }
        : {}),
      ...(agent.retryingSince !== undefined
        ? { requested_at: agent.retryingSince }
        : {}),
      ...(agent.retryDelayMs !== undefined
        ? { delay_ms: agent.retryDelayMs }
        : {}),
    },
    token_count: agent.tokenCount ?? 0,
    tool_count: agent.toolCount ?? 0,
    last_activity_at:
      agent.lastActivityAt ?? agent.endedAt ?? agent.startedAt ?? null,
    ...(agent.resultKind === 'ok'
      ? {
          output: {
            ...(agent.outputShape ? { shape: agent.outputShape } : {}),
            preview: bounded(agent.outputPreview ?? '', 400),
            ...(agent.outputTokens !== undefined
              ? { output_tokens: agent.outputTokens }
              : {}),
          },
        }
      : {}),
    ...(agent.resultKind === 'dead' || agent.failureReason
      ? {
          failure: {
            reason: agent.failureReason ?? 'unknown',
            ...(agent.failureDetail
              ? { detail: bounded(agent.failureDetail, 400) }
              : {}),
            ...(agent.retryable !== undefined
              ? { retryable: agent.retryable }
              : {}),
          },
        }
      : {}),
  }
}

function jsonResult(value: object): ToolCallResult {
  return { data: { output: JSON.stringify(value) } }
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`
}

async function settleDetachedRun(
  promise: Promise<WorkflowRunResult>,
  ports: WorkflowPorts,
  runPorts: WorkflowPorts,
  runId: string,
  workflowName: string,
  taskId: string | undefined,
  instanceId: WorkflowTaskInstanceId | undefined,
): Promise<void> {
  let result: WorkflowRunResult
  try {
    result = await promise
  } catch (error) {
    const message = (error as Error).message
    // runWorkflow can reject before run_started (for example, a journal read
    // failure). Emit a terminal event so the live store and state.json still
    // provide a queryable failure instead of leaving only a failed wrapper.
    runPorts.progressEmitter.emit({
      type: 'run_done',
      runId,
      workflowName,
      ...(taskId ? { taskId } : {}),
      ...(instanceId !== undefined ? { instanceId } : {}),
      status: 'failed',
      error: message,
    })
    await ports.taskRegistrar.fail(runId, message, instanceId)
    return
  }
  // Bookkeeping, deliberately outside the try that owns the run's outcome.
  // taskRegistrar.complete persists state.json and evicts the wrapper task; when
  // that throws it says nothing about whether the workflow succeeded. Sharing one
  // catch with the engine turned a completed run into a run_done {status:'failed'},
  // which is strictly worse than a missing state file — the run_done carrying the
  // real outcome has already been emitted by runWorkflow either way.
  try {
    await onFinish(ports, result, runId, instanceId)
  } catch (error) {
    ports.logger.warn?.(
      `workflow ${runId} finished ${result.status} but bookkeeping failed: ${(error as Error).message}`,
    )
  }
}

function existingRegistrationResult(registration: TaskRegistration): {
  data: { output: string }
} {
  return {
    data: {
      output: [
        'Workflow is already running; reused the canonical background task.',
        `run_id: ${registration.runId}`,
        ...(registration.taskId ? [`task_id: ${registration.taskId}`] : []),
        '',
        'No second workflow engine was launched.',
      ].join('\n'),
    },
  }
}

async function onFinish(
  ports: WorkflowPorts,
  result: WorkflowRunResult,
  runId: string,
  instanceId: WorkflowTaskInstanceId | undefined,
): Promise<void> {
  if (result.status === 'completed') {
    const summary =
      result.returnValue == null
        ? '(no return value)'
        : formatValue(result.returnValue)
    await ports.taskRegistrar.complete(runId, summary, instanceId)
  } else if (result.status === 'failed') {
    await ports.taskRegistrar.fail(
      runId,
      result.error ?? 'workflow failed',
      instanceId,
    )
  } else {
    await ports.taskRegistrar.kill(runId, instanceId)
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') return v.slice(0, 500)
  try {
    return JSON.stringify(v).slice(0, 500)
  } catch {
    return String(v)
  }
}

/**
 * Defensively normalize args: under the legacy `z.string()` contract the model may send a stringified JSON object.
 * Only normalize when the string JSON.parses to an object/array; plain strings, numbers, etc. are preserved as-is.
 */
function normalizeArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed !== null) return parsed
    return raw
  } catch {
    return raw
  }
}

async function resolveScriptSource(
  input: WorkflowRunInput,
  cwd: string,
  workflowDir: string,
): Promise<{ script: string; workflowFile?: string }> {
  if (input.script) return { script: input.script }
  if (input.scriptPath) {
    const resolved = resolve(cwd, input.scriptPath)
    if (!containsPath(cwd, resolved)) {
      throw new Error(
        `scriptPath "${input.scriptPath}" is out of bounds (after resolve, ${resolved} is not within cwd ${cwd})`,
      )
    }
    return {
      script: await readFile(resolved, 'utf-8'),
      workflowFile: resolved,
    }
  }
  if (input.name) {
    if (sanitizeWorkflowName(input.name) === null) {
      throw new Error(
        `Named workflow name "${input.name}" is invalid (contains path separators or is . / ..)`,
      )
    }
    const found = await resolveNamedWorkflow(join(cwd, workflowDir), input.name)
    if (!found) {
      throw new Error(
        `Named workflow "${input.name}" not found (looked in ${workflowDir}/)`,
      )
    }
    return { script: found.content, workflowFile: found.path }
  }
  throw new Error('One of script, name, or scriptPath must be provided')
}
