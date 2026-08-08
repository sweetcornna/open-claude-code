import type { AgentAdapterRegistry } from './agentAdapter.js'
import type {
  AgentRunParams,
  AgentRunResult,
  JournalEntry,
  ProgressEvent,
} from './types.js'

/**
 * Opaque host handle. The core side constructs one per tool call, containing toolUseContext/
 * canUseTool/parentMessage, etc. The package never inspects its internals; it only passes it through to the AgentRunner.
 * This is the only coupling seam between the package and the core layer, and it is opaque.
 */
const HOST_HANDLE = Symbol('workflow.hostHandle')

export type HostBundle = unknown

export type HostHandle = { readonly [HOST_HANDLE]: HostBundle }

/** Used by the core-side hostFactory: wraps any bundle into an opaque handle. */
export function createHostHandle(bundle: HostBundle): HostHandle {
  return { [HOST_HANDLE]: bundle } as HostHandle
}

/** Type guard. */
export function isHostHandle(value: unknown): value is HostHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    HOST_HANDLE in (value as object)
  )
}

/** Used by the core-side adapter: unwraps (only the adapter should call this). */
export function unwrapHostHandle(handle: HostHandle): HostBundle {
  return (handle as { [k: symbol]: HostBundle })[HOST_HANDLE]
}

/** Backend for the agent() hook. */
export type AgentRunner = {
  runAgentToResult(
    params: AgentRunParams,
    host: HostHandle,
  ): Promise<AgentRunResult>
}

/** Progress event emitter. */
export type ProgressEmitter = {
  emit(event: ProgressEvent): void
}

/** Identity of one host-owned execution of a runId. */
export type WorkflowTaskInstanceId = number

export type TaskRegistration = {
  runId: string
  signal: AbortSignal
  /** Canonical host wrapper. Optional for backward-compatible standalone ports. */
  taskId?: string
  /** Host generation token. Production ports always provide it. */
  instanceId?: WorkflowTaskInstanceId
  /** Host metadata used when status lands before the first run_started event. */
  workflowName?: string
  runDir?: string
  /** existing means the caller must reuse this handle and must not launch another engine. */
  disposition?: 'created' | 'existing'
}

type ExactTaskKiller = (
  identifier: string,
  instanceId?: WorkflowTaskInstanceId,
) => boolean | undefined | Promise<boolean | undefined>

type LegacyTaskKiller = (
  identifier: string,
  instanceId?: WorkflowTaskInstanceId,
) => void

/** Background task lifecycle. */
export type TaskRegistrar = {
  /**
   * Register a background task. A duplicate active resume returns disposition=existing with the canonical
   * signal/instance instead of creating another wrapper or engine owner.
   */
  register(
    opts: {
      workflowName: string
      workflowFile?: string
      summary?: string
      toolUseId?: string
      /** On resume, reuse the existing runId (read its journal). Omit to generate a new id. */
      runId?: string
    },
    host: HostHandle,
  ): TaskRegistration
  /** Read the canonical active owner without creating a wrapper. */
  getActive?(runId: string): TaskRegistration | undefined
  complete(
    runId: string,
    summary?: string,
    instanceId?: WorkflowTaskInstanceId,
  ): void | Promise<void>
  fail(
    runId: string,
    error: string,
    instanceId?: WorkflowTaskInstanceId,
  ): void | Promise<void>
  /**
   * External control omits instanceId and targets the canonical owner by runId or wrapper taskId.
   * Engine terminal cleanup supplies instanceId so a stale generation cannot mutate a newer binding.
   * Hosts return true/false for exact control feedback; void remains accepted for old standalone ports.
   */
  kill: ExactTaskKiller | LegacyTaskKiller
  /** Kill every canonical active binding (used by host shutdown). */
  killAll?(): void
  /** Whether instanceId still owns runId. Used to suppress stale generation progress. */
  isCurrent?(runId: string, instanceId: WorkflowTaskInstanceId): boolean
  /**
   * Register an agent-level AbortController. Called by the backend when starting an agent, so that service
   * .kill(runId, agentId) can precisely abort a single agent (without affecting other agents in the same run).
   * Idempotent: re-registering with the same agentId overwrites.
   */
  registerAgentAbort?(
    runId: string,
    agentId: number,
    ac: AbortController,
    instanceId?: WorkflowTaskInstanceId,
  ): void
  /**
   * Unregister an agent-level AbortController (called when the agent completes/fails; idempotent).
   */
  unregisterAgentAbort?(
    runId: string,
    agentId: number,
    instanceId?: WorkflowTaskInstanceId,
  ): void
  /**
   * Abort a single agent. Returns whether it hit (false = agent already completed/does not exist).
   * Does not affect other agents in the same run; the workflow continues (the aborted agent returns dead → null).
   */
  killAgent?(runId: string, agentId: number): boolean
  /** Returns the current pending skip/retry action, or null. */
  pendingAction(runId: string): { kind: 'skip' | 'retry' } | null
}

/** Journal persistence. */
export type JournalStore = {
  read(runId: string): Promise<JournalEntry[]>
  append(runId: string, entry: JournalEntry): Promise<void>
  truncate(runId: string): Promise<void>
  /** Atomic replacement when supported; the engine falls back to truncate + append. */
  rewrite?(runId: string, entries: JournalEntry[]): Promise<void>
}

/** Cancellation / permission gate. */
export type PermissionGate = {
  isAborted(host: HostHandle): boolean
}

/** Logging + telemetry. */
export type Logger = {
  debug(msg: string): void
  event(name: string, metadata?: Record<string, unknown>): void
  /**
   * Warning-level log (e.g. errors swallowed when a single parallel/pipeline item fails).
   * Optional: old ports implementations may omit it; hooks tolerate it with `?.()`.
   */
  warn?(msg: string): void
}

/** Ready-to-use context the engine extracts from the host (handle + basic fields). */
export type WorkflowHostContext = {
  /** Opaque handle passed through to the AgentRunner (contains toolUseContext/canUseTool/parentMessage). */
  handle: HostHandle
  cwd: string
  /** Token budget cap; null means unlimited. */
  budgetTotal: number | null
  /** Core-side tool-use id (passed through to task registration). */
  toolUseId?: string
}

/**
 * Provided by the core side: constructs a WorkflowHostContext from the tool call's core context.
 * The arguments are opaque to the package (unknown); the core-side hostFactory knows the real types.
 */
export type HostFactory = (args: {
  context: unknown
  canUseTool: unknown
  parentMessage: unknown
}) => WorkflowHostContext

/** Host-owned, serializable view of one child agent. */
export type WorkflowAgentStatusSnapshot = {
  id: number
  label?: string
  phase?: string
  status: 'running' | 'done'
  execution?: 'live' | 'replayed'
  resultKind?: string
  outputShape?: 'text' | 'object'
  model?: string
  tokenCount?: number
  toolCount?: number
  startedAt?: number
  endedAt?: number
  lastActivityAt?: number
  outputPreview?: string
  outputTokens?: number
  failureReason?: string
  failureDetail?: string
  retryable?: boolean
  retryCount?: number
  retryLimit?: number
  lastFailureReason?: string
  lastFailureDetail?: string
  retryingSince?: number
  retryDelayMs?: number
}

/** Host-owned snapshot; the package never imports the host progress store. */
export type WorkflowRunStatusSnapshot = {
  runId: string
  /** Identity of the latest host wrapper generation, retained after terminal persistence. */
  taskId?: string
  instanceId?: WorkflowTaskInstanceId
  workflowName: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  currentPhase: string | null
  agents: WorkflowAgentStatusSnapshot[]
  returnValue?: unknown
  error?: string
  updatedAt: number
  runDir: string
}

/** Live-first run lookup. The host may fall back to persisted terminal state. */
export type WorkflowRunStatusReader = {
  getRun(runId: string): Promise<WorkflowRunStatusSnapshot | undefined>
}

/** Aggregate of all ports. Injected into createWorkflowTool(ports). */
export type WorkflowPorts = {
  agentRunner: AgentRunner
  /**
   * Multi-backend adapter registry. When provided, takes precedence over agentRunner — hooks.agent routes
   * to adapter.run via the registry; when omitted, falls back to agentRunner (backward compatibility).
   */
  agentAdapterRegistry?: AgentAdapterRegistry
  progressEmitter: ProgressEmitter
  taskRegistrar: TaskRegistrar
  journalStore: JournalStore
  permissionGate: PermissionGate
  logger: Logger
  hostFactory: HostFactory
  /** Optional for standalone embedders; production supplies the live/durable reader. */
  runStatusReader?: WorkflowRunStatusReader
}

/**
 * Bind engine-side progress and agent-controller cleanup to one host task generation.
 * Standalone ports that do not expose instance identity retain their previous behavior.
 */
export function scopeWorkflowPortsToTaskInstance(
  ports: WorkflowPorts,
  runId: string,
  instanceId: WorkflowTaskInstanceId | undefined,
): WorkflowPorts {
  if (instanceId === undefined) return ports
  const registrar = ports.taskRegistrar
  const isCurrent = (): boolean =>
    registrar.isCurrent?.(runId, instanceId) !== false

  return {
    ...ports,
    progressEmitter: {
      emit(event) {
        if (event.runId === runId && !isCurrent()) return
        ports.progressEmitter.emit(event)
      },
    },
    taskRegistrar: {
      ...registrar,
      ...(registrar.registerAgentAbort
        ? {
            registerAgentAbort(
              id: string,
              agentId: number,
              ac: AbortController,
            ): void {
              registrar.registerAgentAbort?.(id, agentId, ac, instanceId)
            },
          }
        : {}),
      ...(registrar.unregisterAgentAbort
        ? {
            unregisterAgentAbort(id: string, agentId: number): void {
              registrar.unregisterAgentAbort?.(id, agentId, instanceId)
            },
          }
        : {}),
    },
  }
}
