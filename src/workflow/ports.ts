import {
  createFileJournalStore,
  type ProgressEvent,
  type WorkflowPorts,
} from '@open-claude-code/workflow-engine'
import { join } from 'node:path'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { getProjectRoot } from '../bootstrap/state.js'
import { cleanupOldRuns, getRunsDir, writeRunState } from './persistence.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import {
  completeWorkflowTask,
  failWorkflowTask,
  killWorkflowTask,
  reconcileLocalWorkflowTasksForRun,
  registerLocalWorkflowTask,
} from '../tasks/LocalWorkflowTask/LocalWorkflowTask.js'
import {
  buildHostBundle,
  makeHostHandle,
  readHostBundle,
  type WorkflowHostBundle,
} from './hostHandle.js'
import { buildRegistry } from './registry.js'
import {
  scheduleTerminalTaskEviction,
  WORKFLOW_GRACE_MS,
} from '../utils/task/framework.js'
import type { ProgressBus } from './progress/bus.js'
import type { ProgressStore, RunProgress } from './progress/store.js'
import type { SetAppState } from '../Task.js'
import type { AssistantMessage } from '../types/message.js'

type RunBinding = {
  runId: string
  taskId: string
  instanceId: number
  setAppState: SetAppState
  abortController: AbortController
  workflowName: string
  /** agentId → AbortController. Registered when backend starts an agent; killAgent uses it for precise abort. */
  agentAbortControllers: Map<number, AbortController>
  /** Shared terminal persistence/release barrier for duplicate terminal callbacks. */
  terminalizing?: Promise<void>
}

/**
 * Read-only view over the runId → background-task bindings that `taskRegistrar`
 * already maintains for kill routing.
 *
 * Exposed rather than duplicated: {@link import('./taskStateBridge.js')} needs to find the
 * LocalWorkflowTask behind a run in order to patch live progress into it, and a second
 * runId→taskId map would inevitably drift from this one (which is deleted on
 * complete/fail/kill). Both lookups return undefined once the binding is reclaimed, which
 * is exactly the "no host/task context" signal the bridge treats as inert.
 */
export type WorkflowTaskBindings = {
  /** runId → id of the registered LocalWorkflowTask; undefined once the run is reclaimed. */
  getTaskIdForRun(runId: string): string | undefined
  /** runId → the setAppState captured at registration (needed to write into AppState). */
  getSetAppStateForRun(runId: string): SetAppState | undefined
}

/** Constructs a WorkflowHostContext from toolUseContext on each tool invocation. */
function makeHostFactory(): WorkflowPorts['hostFactory'] {
  return ({ context, canUseTool, parentMessage }) => {
    const ctx = context as WorkflowHostBundle['toolUseContext'] & {
      agentId?: string
    }
    return {
      handle: makeHostHandle(
        buildHostBundle(
          ctx,
          canUseTool as WorkflowHostBundle['canUseTool'],
          parentMessage as AssistantMessage | undefined,
        ),
      ),
      // Use projectRoot rather than getCwd(): shares the same root as journalStore's runsDir,
      // otherwise named workflow resolution and journal persistence diverge when the user
      // enters a worktree/sub-directory. The engine's internal ctx.cwd is only used for
      // resolution (scriptPath/name) and does not affect the agent's execution cwd
      // (the agent gets its own cwd via the toolUseContext inside the host bundle).
      cwd: getProjectRoot(),
      budgetTotal: null, // turn-level budget injection point (read from settings in the future)
      ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}),
    }
  }
}

/**
 * Assembles the complete WorkflowPorts. bus/store are passed in by the caller (shared via the service singleton).
 * taskRegistrar maintains runId → RunBinding for kill routing.
 */
export function createWorkflowPorts(opts: {
  bus: ProgressBus
  store: ProgressStore
  /** Test seam; production uses the isolated project workflow-runs directory. */
  runsDir?: string
  /** Test seam for asserting persistence-before-release ordering. */
  persistRunState?: (run: RunProgress) => Promise<void>
}): WorkflowPorts & WorkflowTaskBindings {
  const bindings = new Map<string, RunBinding>()
  const latestInstances = new Map<string, number>()
  let nextInstanceId = 1
  const runsDir = opts.runsDir ?? getRunsDir()
  const persistRunState =
    opts.persistRunState ?? ((run: RunProgress) => writeRunState(runsDir, run))
  const registry = buildRegistry()

  const bindingFor = (
    identifier: string,
    instanceId?: number,
  ): RunBinding | undefined => {
    const binding =
      bindings.get(identifier) ??
      [...bindings.values()].find(candidate => candidate.taskId === identifier)
    if (instanceId !== undefined && binding?.instanceId !== instanceId) {
      return undefined
    }
    return binding
  }

  const scheduleRunProgressEviction = (binding: RunBinding): void => {
    const timer = setTimeout(() => {
      if (latestInstances.get(binding.runId) !== binding.instanceId) return
      if (bindings.has(binding.runId)) return
      opts.store.remove(binding.runId)
      if (latestInstances.get(binding.runId) === binding.instanceId) {
        latestInstances.delete(binding.runId)
      }
    }, WORKFLOW_GRACE_MS + 1_000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const releaseBinding = (binding: RunBinding): void => {
    if (bindings.get(binding.runId)?.instanceId !== binding.instanceId) return
    bindings.delete(binding.runId)
    scheduleRunProgressEviction(binding)
  }

  const abortBinding = (binding: RunBinding): void => {
    binding.abortController.abort()
    for (const ac of binding.agentAbortControllers.values()) {
      try {
        ac.abort()
      } catch {
        // no-op: abort won't throw internally, but fail-closed
      }
    }
    binding.agentAbortControllers.clear()
  }

  const persistThenRelease = (
    binding: RunBinding,
    terminalize: () => void,
  ): Promise<void> => {
    if (binding.terminalizing) return binding.terminalizing
    binding.terminalizing = (async () => {
      const run = opts.store.get(binding.runId)
      if (run && run.status !== 'running') {
        await persistRunState(run)
        void cleanupOldRuns(runsDir).catch(error => {
          logForDebugging(
            `[workflow warn] cleanupOldRuns after terminal state failed: ${(error as Error).message}`,
          )
        })
      } else {
        logForDebugging(
          `[workflow warn] terminal task ${binding.runId} has no terminal progress snapshot`,
        )
      }
      // A wrapper cannot satisfy the host's terminal-eviction predicate until
      // its durable state is available to status/query.
      terminalize()
      scheduleTerminalTaskEviction(
        binding.taskId,
        binding.setAppState,
        WORKFLOW_GRACE_MS,
      )
      releaseBinding(binding)
    })()
    return binding.terminalizing
  }

  // Telemetry subscription (independent of store). LogEventMetadata only accepts boolean/number/undefined,
  // and runId is a string — use the brand cast provided by the analytics module (verified non-code/path) to pass it through.
  opts.bus.subscribe((e: ProgressEvent) => {
    if (e.type === 'run_done') {
      logEvent('tengu_workflow_done', {
        status: e.status === 'completed' ? 0 : e.status === 'failed' ? 1 : 2,
        runId:
          e.runId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
  })

  const taskRegistrar: WorkflowPorts['taskRegistrar'] = {
    register(regOpts, host) {
      const bundle = readHostBundle(host)
      const setAppState =
        bundle.toolUseContext.setAppStateForTasks ??
        bundle.toolUseContext.setAppState

      if (regOpts.runId) {
        const existing = bindings.get(regOpts.runId)
        if (existing) {
          reconcileLocalWorkflowTasksForRun(
            existing.runId,
            existing.taskId,
            setAppState,
          )
          logForDebugging(
            `workflow task reused: ${existing.runId} (${existing.workflowName})`,
          )
          return {
            runId: existing.runId,
            taskId: existing.taskId,
            signal: existing.abortController.signal,
            instanceId: existing.instanceId,
            workflowName: existing.workflowName,
            runDir: join(runsDir, existing.runId),
            disposition: 'existing',
          }
        }

        // A legacy overwritten binding can leave live wrappers behind. Abort and
        // terminalize them before assigning a new canonical owner.
        reconcileLocalWorkflowTasksForRun(regOpts.runId, undefined, setAppState)
      }

      const abortController = new AbortController()
      const taskId = registerLocalWorkflowTask(setAppState, {
        description: regOpts.summary ?? regOpts.workflowName,
        workflowName: regOpts.workflowName,
        workflowFile: regOpts.workflowFile ?? '',
        summary: regOpts.summary,
        ...(regOpts.toolUseId ? { toolUseId: regOpts.toolUseId } : {}),
        ...(regOpts.runId ? { runId: regOpts.runId } : {}),
        runsDir,
        abortController,
      })
      const runId = regOpts.runId ?? taskId
      const instanceId = nextInstanceId++
      const binding: RunBinding = {
        runId,
        taskId,
        instanceId,
        setAppState,
        abortController,
        workflowName: regOpts.workflowName,
        agentAbortControllers: new Map(),
      }
      bindings.set(runId, binding)
      latestInstances.set(runId, instanceId)
      logForDebugging(
        `workflow task registered: ${runId}#${instanceId} (${regOpts.workflowName})`,
      )
      return {
        runId,
        taskId,
        signal: abortController.signal,
        instanceId,
        workflowName: regOpts.workflowName,
        runDir: join(runsDir, runId),
        disposition: 'created',
      }
    },
    getActive(runId) {
      const existing = bindings.get(runId)
      if (!existing) return undefined
      reconcileLocalWorkflowTasksForRun(
        existing.runId,
        existing.taskId,
        existing.setAppState,
      )
      return {
        runId: existing.runId,
        taskId: existing.taskId,
        signal: existing.abortController.signal,
        instanceId: existing.instanceId,
        workflowName: existing.workflowName,
        runDir: join(runsDir, existing.runId),
        disposition: 'existing',
      }
    },
    complete(runId, summary, instanceId) {
      const binding = bindingFor(runId, instanceId)
      if (!binding) return
      logForDebugging(
        `workflow ${runId}#${binding.instanceId} completed: ${summary ?? ''}`,
      )
      return persistThenRelease(binding, () =>
        completeWorkflowTask(binding.taskId, binding.setAppState),
      )
    },
    fail(runId, error, instanceId) {
      const binding = bindingFor(runId, instanceId)
      if (!binding) return
      logForDebugging(
        `workflow ${runId}#${binding.instanceId} failed: ${error}`,
      )
      return persistThenRelease(binding, () =>
        failWorkflowTask(binding.taskId, binding.setAppState, error),
      )
    },
    kill(identifier, instanceId) {
      const binding = bindingFor(identifier, instanceId)
      if (!binding) return false
      abortBinding(binding)
      // External control deliberately keeps ownership until runWorkflow settles,
      // preventing a resume from launching while the killed engine unwinds.
      if (instanceId === undefined) return true
      return persistThenRelease(binding, () =>
        killWorkflowTask(binding.taskId, binding.setAppState),
      ).then(() => true)
    },
    killAll() {
      for (const binding of [...bindings.values()]) {
        try {
          abortBinding(binding)
        } catch (error) {
          logForDebugging(
            `workflow shutdown: kill ${binding.runId} failed: ${(error as Error).message}`,
          )
        }
      }
    },
    isCurrent(runId, instanceId) {
      return bindings.get(runId)?.instanceId === instanceId
    },
    registerAgentAbort(runId, agentId, ac, instanceId) {
      const binding = bindingFor(runId, instanceId)
      if (!binding) {
        ac.abort()
        return
      }
      if (binding.abortController.signal.aborted) {
        ac.abort()
        return
      }
      binding.agentAbortControllers.set(agentId, ac)
    },
    unregisterAgentAbort(runId, agentId, instanceId) {
      bindingFor(runId, instanceId)?.agentAbortControllers.delete(agentId)
    },
    killAgent(identifier, agentId) {
      const binding = bindingFor(identifier)
      if (!binding) return false
      const ac = binding.agentAbortControllers.get(agentId)
      if (!ac) return false
      try {
        ac.abort()
      } catch {
        // no-op
      }
      binding.agentAbortControllers.delete(agentId)
      return true
    },
    pendingAction() {
      return null // v1: skip/retry not wired (seam retained)
    },
  }

  return {
    getTaskIdForRun: runId => bindings.get(runId)?.taskId,
    getSetAppStateForRun: runId => bindings.get(runId)?.setAppState,
    hostFactory: makeHostFactory(),
    agentAdapterRegistry: registry,
    agentRunner: {
      // Dead-code fallback: hooks always go through agentAdapterRegistry (required on ports). Reaching here means the registry was not registered — fail-fast.
      async runAgentToResult() {
        throw new Error(
          'workflow agentRunner fallback reached — agentAdapterRegistry must be set on ports',
        )
      },
    },
    progressEmitter: {
      emit(event) {
        opts.bus.emit(event) // → store reducer + telemetry
      },
    },
    taskRegistrar,
    journalStore: createFileJournalStore(runsDir),
    permissionGate: { isAborted: () => false }, // engine uses ctx.signal to check abort
    logger: {
      debug: msg => logForDebugging(msg),
      warn: msg => logForDebugging(`[workflow warn] ${msg}`),
      event: name => logForDebugging(`workflow event: ${name}`),
    },
  }
}
