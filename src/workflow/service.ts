import {
  isScriptChanged,
  isSelectiveResumePolicy,
  listNamedWorkflows,
  parseScript,
  persistInlineScript,
  recordScriptHash,
  resolveNamedWorkflow,
  runWorkflow,
  scopeWorkflowPortsToTaskInstance,
  type WorkflowHostContext,
  type WorkflowPorts,
  type WorkflowRunInput,
  type WorkflowRunResult,
  type WorkflowTaskInstanceId,
} from '@open-claude-code/workflow-engine'
import { feature } from 'bun:bundle'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getProjectRoot } from '../bootstrap/state.js'
import { PROJECT_DIR_NAME } from '../config/paths.js'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { buildHostBundle, makeHostHandle } from './hostHandle.js'
import { installWorkflowNotifications } from './notifications.js'
import { getRunsDir, listPersistedRuns, readRunState } from './persistence.js'

/**
 * How many newest persisted runs to hydrate into the store on panel open. Tuned to cover a normal
 * day's worth of workflow iterations without overrunning the panel tab row; anything older stays
 * on disk and is still resumable via getRunAsync until cleanupOldRuns reclaims it.
 */
const LOAD_PERSISTED_LIMIT = 20
export const OCC_WORKFLOW_DIR = join(PROJECT_DIR_NAME, 'workflows')
export const OCC_WORKFLOW_RUNS_DIR = join(PROJECT_DIR_NAME, 'workflow-runs')
import { createProgressBus } from './progress/bus.js'
import {
  createProgressStoreFromBus,
  type ProgressStore,
  type RunProgress,
} from './progress/store.js'
import { createWorkflowPorts } from './ports.js'
import { installWorkflowTaskStateBridge } from './taskStateBridge.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../Tool.js'

/**
 * Session-wide override of the engine's DEFAULT_MAX_CONCURRENCY, for users whose rate limits
 * (or patience) differ from the default. Read here rather than in the engine package, which is
 * deliberately free of process.env so it stays testable and embeddable.
 *
 * Only fills the default: an explicit maxConcurrency on the call always wins, and the engine's
 * clampMaxConcurrency still applies MAX_CONCURRENCY_CAP. Garbage or a non-positive value falls
 * back to the engine default (same posture as spawnLimits.ts).
 */
export function workflowDefaultMaxConcurrency(): number | undefined {
  const raw = process.env.OCC_WORKFLOW_MAX_CONCURRENCY
  if (raw === undefined) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * WorkflowService: the single entry shared by the tool (U7) and panel (U9).
 *
 * - `ports`: shared WorkflowPorts; tool descriptors are passed through to the engine.
 * - `launch`: parse script → parseScript quick validation → taskRegistrar.register (gets runId+signal)
 *   → detached runWorkflow → on completion routes to complete/fail/kill.
 * - `kill/listRuns/getRun/subscribe/listNamed`: auxiliary queries for panel and tool.
 */
export type WorkflowService = {
  /** Shared ports (used by tool descriptors). */
  ports: WorkflowPorts
  /** Panel/tool launches a workflow: parse script → register → detached runWorkflow. */
  launch(
    input: Pick<
      WorkflowRunInput,
      | 'script'
      | 'name'
      | 'scriptPath'
      | 'args'
      | 'description'
      | 'resumeFromRunId'
      | 'resumePolicy'
      | 'title'
      | 'maxConcurrency'
    >,
    toolUseContext: ToolUseContext,
    canUseTool: CanUseToolFn,
  ): Promise<{
    runId: string
    taskId?: string
    disposition: 'created' | 'existing'
    scriptPath?: string
  }>
  /** Cancel the active run and report whether a canonical owner was hit. */
  kill(runId: string): boolean
  /**
   * Aborts a single agent (does not affect other agents in the same run; workflow keeps running).
   * Returns whether the agent was hit (false = agent already finished/does not exist). An aborted agent returns dead → null.
   */
  killAgent(runId: string, agentId: number): boolean
  /**
   * Cleanup on process exit / config unload: kill all running runs to avoid orphan tasks.
   * Completed/failed runs are unaffected. Idempotent — safe to call multiple times.
   */
  shutdown(): void
  listRuns(): RunProgress[]
  getRun(runId: string): RunProgress | undefined
  /**
   * Async lookup by runId: return on memory hit; on miss read state.json from disk (not injected into memory).
   * Used by the "get historical return by runId" scenario; for panel display use loadPersistedRuns + listRuns.
   */
  getRunAsync(runId: string): Promise<RunProgress | undefined>
  /**
   * Scans the disk and hydrates state.json of all historical runs into the store (skips existing runIds).
   * The process singleton only scans the disk once (persistedLoaded flag); repeated calls return immediately.
   */
  loadPersistedRuns(): Promise<void>
  subscribe(listener: () => void): () => void
  listNamed(workflowDir?: string): Promise<string[]>
}

let cached: WorkflowService | null = null

/** Process singleton. Tool and panel share the same ports/registry/store. */
export function getWorkflowService(): WorkflowService {
  if (cached) return cached
  const bus = createProgressBus()
  const store = createProgressStoreFromBus(bus)
  const ports = createWorkflowPorts({ bus, store })
  const service = makeService(ports, store)
  // Terminal persistence is owned by the task registrar: it reads this same store
  // after run_done and awaits state.json before releasing the live binding.
  // Install the state-change notification bridge (commit 0768d4dc promised "auto-notify on completion" but the old implementation left it unfulfilled)
  installWorkflowNotifications(service)
  // Stream live phase/agent progress into the registered background task so the footer
  // pill and the Shift+Down dialog show run status without opening the /workflows panel.
  // Reads the same `bindings` map the registrar uses for kill routing (via ports).
  if (feature('WORKFLOW_SCRIPTS')) {
    installWorkflowTaskStateBridge(store, ports)
  }
  cached = service
  return cached
}

/**
 * Construct the service (inject ports + store).
 *
 * Production path uses {@link getWorkflowService}; tests use this function to inject fake ports directly,
 * avoiding touching real getProjectRoot/getCwd/analytics and other module-level side effects.
 *
 * @param cwdOverride For tests only: inject a temp directory (avoids inline persistence writing to the real project directory).
 * @param runsDirProvider For tests only: inject a tmpdir (Bun ESM module namespace is read-only, cannot monkey-patch getRunsDir).
 * @param retryBackoffMs For tests only: shrink the engine's in-place agent-retry backoff to keep retry tests instant.
 */
export function makeService(
  ports: WorkflowPorts,
  store: ProgressStore,
  cwdOverride?: string,
  runsDirProvider: () => string = getRunsDir,
  retryBackoffMs?: number,
): WorkflowService {
  const buildHost = (
    toolUseContext: ToolUseContext,
    canUseTool: CanUseToolFn,
  ): WorkflowHostContext => ({
    handle: makeHostHandle(buildHostBundle(toolUseContext, canUseTool)),
    // Use projectRoot to stay in sync with ports.ts hostFactory / journalStore;
    // entering a worktree/subdirectory will not desync named workflow resolution from journal persistence.
    // cwdOverride is for tests only: inject a temp directory (avoids inline persistence writing to the real project directory).
    cwd: cwdOverride ?? getProjectRoot(),
    budgetTotal: null, // turn-level budget injection point (in future read from settings)
    toolUseId: toolUseContext.toolUseId,
  })

  async function resolveSource(input: {
    script?: string
    name?: string
    scriptPath?: string
    title?: string
  }): Promise<{
    script: string
    workflowFile?: string
    workflowName: string
  }> {
    // Mirrors WorkflowTool.ts: name takes priority over title; only fall back to the literal
    // 'workflow' when neither is supplied (so /workflows tabs don't pile up under a same default name).
    const workflowName = input.name ?? input.title ?? 'workflow'
    if (input.script) {
      return { script: input.script, workflowName }
    }
    if (input.scriptPath) {
      return {
        script: await readFile(input.scriptPath, 'utf-8'),
        workflowFile: input.scriptPath,
        workflowName,
      }
    }
    if (input.name) {
      const dir = join(getProjectRoot(), OCC_WORKFLOW_DIR)
      const found = await resolveNamedWorkflow(dir, input.name)
      if (!found) {
        throw new Error(
          `Named workflow "${input.name}" not found (looked in ${OCC_WORKFLOW_DIR}/)`,
        )
      }
      return {
        script: found.content,
        workflowFile: found.path,
        workflowName: input.name,
      }
    }
    throw new Error('One of script, name, or scriptPath must be provided')
  }

  // Process-singleton flag for loadPersistedRuns: set to true on first call, subsequent calls return immediately.
  // Reset on scan failure to allow next retry. Each makeService call has its own closure variable (reset when tests build a new service).
  let persistedLoaded = false

  const service: WorkflowService = {
    ports,

    async launch(input, toolUseContext, canUseTool) {
      if (input.resumeFromRunId) {
        const active = ports.taskRegistrar.getActive?.(input.resumeFromRunId)
        if (active) {
          return {
            runId: active.runId,
            ...(active.taskId ? { taskId: active.taskId } : {}),
            disposition: 'existing',
          }
        }
      }

      const { script, workflowFile, workflowName } = await resolveSource(input)
      try {
        parseScript(script)
      } catch (e) {
        throw new Error(`Script validation failed: ${(e as Error).message}`)
      }

      const host = buildHost(toolUseContext, canUseTool)

      // Same script-hash contract as the Workflow tool, and it has to be the same or
      // the two entries fight: the panel used to launch runs without ever writing
      // script.sha256, so every later selective resume of a panel-started run failed
      // with "requires an unchanged workflow script" against a hash that was never
      // recorded. Read here, recorded only after this call wins registration.
      const selective =
        input.resumePolicy !== undefined &&
        isSelectiveResumePolicy(input.resumePolicy)
      let scriptChanged = false
      if (input.resumeFromRunId) {
        try {
          scriptChanged = await isScriptChanged({
            script,
            runId: input.resumeFromRunId,
            cwd: host.cwd,
            workflowRunsDir: OCC_WORKFLOW_RUNS_DIR,
          })
        } catch (e) {
          if (selective) {
            throw new Error(
              `Selective resume could not verify the prior script hash: ${(e as Error).message}`,
            )
          }
          // A resume without trustworthy hash state must not replay checkpoints
          // from a script we can no longer prove is identical.
          scriptChanged = true
          logForDebugging(
            `workflow script hash check failed: ${(e as Error).message}`,
          )
        }
        if (scriptChanged && selective) {
          throw new Error(
            'Selective resume requires an unchanged workflow script; use resume scope "all" to rerun the changed script',
          )
        }
      }

      const registration = ports.taskRegistrar.register(
        {
          workflowName,
          ...(workflowFile ? { workflowFile } : {}),
          ...(input.description ? { summary: input.description } : {}),
          ...(host.toolUseId ? { toolUseId: host.toolUseId } : {}),
          ...(input.resumeFromRunId ? { runId: input.resumeFromRunId } : {}),
        },
        host.handle,
      )
      const { runId, signal, instanceId } = registration
      if (registration.disposition === 'existing') {
        return {
          runId,
          ...(registration.taskId ? { taskId: registration.taskId } : {}),
          disposition: 'existing',
        }
      }

      // Inline entry: persist script to the run directory (symmetric with WorkflowTool), return a reusable path.
      // Degrade on write failure (log), do not block the run (script is already in memory).
      let persistedScriptPath: string | undefined
      if (!workflowFile && input.script) {
        try {
          persistedScriptPath = await persistInlineScript(
            input.script,
            runId,
            host.cwd,
            OCC_WORKFLOW_RUNS_DIR,
          )
        } catch (e) {
          logForDebugging(
            `workflow inline script persist failed: ${(e as Error).message}`,
          )
        }
      }

      // Past the single-flight gate: only the launch that actually runs this script
      // may stamp the run with its hash (see the tool's copy for why the loser of two
      // concurrent resumes must not).
      try {
        await recordScriptHash({
          script,
          runId,
          cwd: host.cwd,
          workflowRunsDir: OCC_WORKFLOW_RUNS_DIR,
        })
      } catch (e) {
        logForDebugging(
          `workflow script hash persistence failed: ${(e as Error).message}`,
        )
      }

      const launchConcurrency =
        input.maxConcurrency ?? workflowDefaultMaxConcurrency()

      // detached: do not await, let the caller get runId immediately; on completion route to the registrar.
      const runPorts = scopeWorkflowPortsToTaskInstance(
        ports,
        runId,
        instanceId,
      )
      void settleServiceRun(
        runWorkflow({
          script,
          ...(input.args !== undefined ? { args: input.args } : {}),
          runId,
          workflowName,
          ...(registration.taskId ? { taskId: registration.taskId } : {}),
          ...(instanceId !== undefined ? { instanceId } : {}),
          ports: runPorts,
          host: host.handle,
          signal,
          cwd: host.cwd,
          budgetTotal: host.budgetTotal,
          // Explicit input wins; otherwise OCC_WORKFLOW_MAX_CONCURRENCY, otherwise the
          // engine's DEFAULT_MAX_CONCURRENCY. Same precedence as the Workflow tool path.
          ...(launchConcurrency !== undefined
            ? { maxConcurrency: launchConcurrency }
            : {}),
          ...(input.resumeFromRunId
            ? {
                resume: true,
                scriptChanged,
                ...(input.resumePolicy
                  ? { resumePolicy: input.resumePolicy }
                  : {}),
              }
            : {}),
          ...(retryBackoffMs !== undefined ? { retryBackoffMs } : {}),
          workflowDir: OCC_WORKFLOW_DIR,
        }),
        ports,
        runPorts,
        runId,
        workflowName,
        registration.taskId,
        instanceId,
      ).catch(e => {
        // Terminal safety net for a detached promise. settleServiceRun already
        // handles every failure it can attribute to the run; anything reaching here
        // failed while *reporting* one, and an unhandled rejection here would take
        // the session down rather than one workflow.
        logForDebugging(
          `workflow ${runId} settlement failed: ${(e as Error).message}`,
        )
      })

      logForDebugging(`workflow launched: ${runId} (${workflowName})`)
      return {
        runId,
        ...(registration.taskId ? { taskId: registration.taskId } : {}),
        disposition: 'created',
        ...(persistedScriptPath ? { scriptPath: persistedScriptPath } : {}),
      }
    },

    kill(runId) {
      return ports.taskRegistrar.kill(runId) === true
    },
    killAgent(runId, agentId) {
      return ports.taskRegistrar.killAgent?.(runId, agentId) ?? false
    },

    shutdown() {
      // Production ports own the canonical binding registry, including runs that
      // have registered but have not emitted run_started yet. Prefer that source
      // over the progress snapshot so shutdown cannot miss a wrapper taskId/runId
      // mismatch or a journal-read startup window.
      if (ports.taskRegistrar.killAll) {
        ports.taskRegistrar.killAll()
        return
      }

      // Backward-compatible standalone ports fall back to the progress store.
      for (const run of store.list()) {
        if (run.status !== 'running') continue
        try {
          ports.taskRegistrar.kill(run.runId)
        } catch (e) {
          logForDebugging(
            `workflow shutdown: kill ${run.runId} failed: ${(e as Error).message}`,
          )
        }
      }
    },

    listRuns: () => store.list(),
    getRun: id => store.get(id),
    async getRunAsync(id) {
      const mem = store.get(id)
      if (mem) return mem
      return (await readRunState(runsDirProvider(), id)) ?? undefined
    },
    async loadPersistedRuns() {
      if (persistedLoaded) return
      persistedLoaded = true
      try {
        // Cap hydration at LOAD_PERSISTED_LIMIT newest runs so the panel tab row doesn't drown
        // under accumulated history. Older state.json files stay on disk (within KEEP_MAX_RUNS,
        // maintained by cleanupOldRuns) and remain resumable via getRunAsync.
        const runs = await listPersistedRuns(
          runsDirProvider(),
          LOAD_PERSISTED_LIMIT,
        )
        for (const run of runs) store.hydrate(run)
      } catch (e) {
        // Scan failure does not block the panel: log + reset flag to allow next retry
        logForDebugging(
          `[workflow warn] loadPersistedRuns failed: ${(e as Error).message}`,
        )
        persistedLoaded = false
      }
    },
    subscribe: fn => store.subscribe(fn),

    async listNamed(workflowDir) {
      return listNamedWorkflows(
        workflowDir ?? join(getProjectRoot(), OCC_WORKFLOW_DIR),
      )
    },
  }

  // Host facade for the package-level Workflow tool. It reads the existing live
  // store first and uses getRunAsync's state.json fallback without maintaining a
  // second run registry.
  ports.runStatusReader = {
    async getRun(runId) {
      const run = await service.getRunAsync(runId)
      return run
        ? {
            ...run,
            agents: [...run.agents],
            runDir: join(runsDirProvider(), runId),
          }
        : undefined
    },
  }
  return service
}

async function settleServiceRun(
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
  // Bookkeeping only, and deliberately outside the try that owns the run's outcome:
  // complete/fail/kill persist state.json and evict the wrapper task, so a throw
  // there means "the record could not be written", not "the workflow failed".
  // Sharing one catch turned a successful run into a failed one.
  try {
    if (result.status === 'completed') {
      await ports.taskRegistrar.complete(runId, undefined, instanceId)
    } else if (result.status === 'failed') {
      await ports.taskRegistrar.fail(
        runId,
        result.error ?? 'failed',
        instanceId,
      )
    } else {
      await ports.taskRegistrar.kill(runId, instanceId)
    }
  } catch (error) {
    logForDebugging(
      `workflow ${runId} finished ${result.status} but bookkeeping failed: ${(error as Error).message}`,
    )
  }
}

/** For tests: reset the singleton (avoid cross-case contamination). */
export function __resetWorkflowServiceForTests(): void {
  cached = null
}

/**
 * Returns the already-instantiated service (does not create one). Used on process exit / config unload to peek;
 * if workflow was never used, cached is still null — avoids side-effecting bus/ports creation in the exit hook.
 */
export function peekWorkflowService(): WorkflowService | null {
  return cached
}
