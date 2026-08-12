/**
 * Automatic backgrounding for slow MCP tool calls.
 *
 * An MCP call has, in practice, no timeout: `getMcpToolTimeoutMs()` defaults to
 * 100_000_000 ms (~28h). So a server that decides to take ten minutes holds the whole
 * conversation hostage — the model cannot think, the user cannot get an answer, and
 * nothing in the session rescues it the way `shellCommand.onTimeout` rescues Bash.
 *
 * This module is the rescue. Past a threshold the call keeps running on a *detached*
 * abort controller, becomes a background task, and the model immediately gets a result
 * saying so. When the call finally settles, its output lands in the task's output file
 * and a task notification carries the outcome back.
 *
 * The detachment is the load-bearing part. The parent abort controller dies at the end
 * of the turn; if the in-flight request stayed wired to it, "moved to the background"
 * would be a lie — the request would be cancelled the moment the model's next turn began.
 * So the run is started on its own controller with a *relay* from the parent, and the
 * relay is severed at exactly the moment the task is handed over.
 *
 * Ported from upstream Claude Code (callMcpToolWithAutoBackground / getMcpAutoBackgroundMs).
 */

import { isEnvTruthy } from '../../utils/config/envUtils.js'
import { logEvent } from '../analytics/index.js'
import { logForDebugging } from '../../utils/telemetry/debug.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import {
  registerMcpBackgroundTask,
  settleMcpBackgroundTask,
} from '../../tasks/MonitorMcpTask/MonitorMcpTask.js'
import type { MCPToolResult } from '../../utils/mcp/mcpValidation.js'
import type { McpServerConfig } from './types.js'

type SetAppState = (updater: (prev: AppState) => AppState) => void

/**
 * Upstream default: two minutes. Long enough that ordinary tools (which answer in
 * milliseconds to a few seconds) never trip it, short enough that a wedged server does
 * not eat a whole coffee break of the user's turn.
 */
export const DEFAULT_MCP_AUTO_BACKGROUND_MS = 120_000

/**
 * Ceiling for the env override. `setTimeout` silently truncates delays past the signed
 * 32-bit range and fires *immediately* instead — so an operator typing an extra zero
 * would get the exact opposite of the intent (background everything at once).
 */
export const MAX_MCP_AUTO_BACKGROUND_MS = 2_147_483_647

/**
 * Env override, in milliseconds. `0` disables auto-backgrounding entirely.
 *
 * Internal: the name is also spelled out in `managedEnvConstants.ts` (settings.json
 * allowlist) and in this module's tests, both of which need the literal rather than a
 * binding, so exporting it would buy nothing but an unused-export report.
 */
const MCP_AUTO_BACKGROUND_MS_ENV = 'CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS'

/**
 * Transports that must never be backgrounded.
 *
 * These are the IDE sidecar connections. Their calls are the IDE asking Claude a
 * question (or vice versa) within a live UI interaction — handing one to a background
 * task would answer the editor with "it's running in the background", which is never a
 * useful reply to a diagnostics or selection query.
 */
const NON_BACKGROUNDABLE_TRANSPORTS: ReadonlySet<string> = new Set([
  'sse-ide',
  'ws-ide',
])

/**
 * How long a call from this server may block before it is auto-backgrounded.
 * `0` means "never auto-background".
 *
 * Order matters: the categorical refusals come first, so neither the env override nor
 * the default can re-enable backgrounding for an IDE transport or for a session that
 * disabled background tasks outright.
 */
export function getMcpAutoBackgroundMs(
  config: Pick<McpServerConfig, 'type'> | undefined,
  {
    isNonInteractiveSession = false,
  }: { isNonInteractiveSession?: boolean } = {},
): number {
  if (NON_BACKGROUNDABLE_TRANSPORTS.has(config?.type ?? '')) return 0
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) return 0
  // Print/SDK sessions have no user to notice a pill and no next turn to receive the
  // notification unless they opted in, so the default there is to keep blocking.
  if (
    isNonInteractiveSession &&
    !isEnvTruthy(process.env.CLAUDE_AUTO_BACKGROUND_TASKS)
  ) {
    return 0
  }

  const raw = process.env[MCP_AUTO_BACKGROUND_MS_ENV]
  if (raw !== undefined && raw !== '') {
    const parsed = Number.parseInt(raw, 10)
    // A garbage value must not silently become "background instantly" (NaN would clamp
    // to 0 through Math.max) — fall through to the default instead.
    if (Number.isFinite(parsed)) {
      return Math.min(Math.max(0, parsed), MAX_MCP_AUTO_BACKGROUND_MS)
    }
    logForDebugging(
      `${MCP_AUTO_BACKGROUND_MS_ENV}="${raw}" is not an integer; using the default`,
    )
  }

  return DEFAULT_MCP_AUTO_BACKGROUND_MS
}

/**
 * Relays aborts from `parent` to `child` until the returned function is called.
 *
 * Not `AbortSignal.any`: that produces a signal permanently welded to its sources, and
 * the entire point here is to be able to cut the wire when the call is handed to a
 * background task. Returns a detach function that is safe to call more than once.
 */
export function attachDetachableAbortRelay(
  parent: AbortController,
  child: AbortController,
): () => void {
  let detached = false
  const onAbort = () => {
    child.abort(parent.signal.reason)
  }
  if (parent.signal.aborted) {
    onAbort()
    return () => {}
  }
  parent.signal.addEventListener('abort', onAbort, { once: true })
  return () => {
    if (detached) return
    detached = true
    parent.signal.removeEventListener('abort', onAbort)
  }
}

/** Resolves after `ms`, or as soon as `signal` aborts. Never rejects. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    // Unref so a pending auto-background timer can never hold the process open — a
    // `-p` run that finishes its turn must be free to exit.
    if (typeof timer.unref === 'function') timer.unref()
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Parameter bag for {@link callMcpToolWithAutoBackground}; not part of the surface. */
type McpAutoBackgroundOptions<T> = {
  /**
   * Starts the actual call. Receives the *detached* signal — the one that survives the
   * parent's abort — so the caller must thread it all the way to the transport rather
   * than closing over `parentAbortController.signal`.
   */
  run: (signal: AbortSignal) => Promise<T>
  serverName: string
  toolName: string
  toolUseId?: string
  agentId?: AgentId
  parentAbortController: AbortController
  autoBackgroundMs: number
  setAppState: SetAppState
  /**
   * True while the server is waiting on a user prompt (an elicitation). Backgrounding
   * then would be actively wrong: the call is not slow, it is blocked on the human, and
   * the "still running after Ns" message would blame the server for the user's pause.
   * Re-checked each time the timer fires, so the clock effectively restarts.
   */
  hasPendingElicitation?: () => boolean
  /** Called once, right after the handover, before the placeholder result is returned. */
  onBackgrounded?: (taskId: string) => void
  /** Renders the settled value into the text stored for the model. */
  describeResult: (value: T) => string
  /** Builds the placeholder returned to the model in place of the real result. */
  buildBackgroundedResult: (info: {
    taskId: string
    elapsedSeconds: number
  }) => T
  /**
   * Task-registry seam. Injectable for testing so this module's own behaviour can be
   * exercised without standing up AppState and the notification queue — the same trick
   * `callMCPToolWithUrlElicitationRetry` uses for `callToolFn`. Production passes
   * nothing and gets the real registry.
   */
  registerTask?: typeof registerMcpBackgroundTask
  settleTask?: typeof settleMcpBackgroundTask
}

/**
 * Runs an MCP tool call, moving it to a background task if it outlives
 * `autoBackgroundMs`.
 *
 * Returns the real result when the call finishes in time (the overwhelmingly common
 * case), and a placeholder describing the handover when it does not.
 */
export async function callMcpToolWithAutoBackground<T>({
  run,
  serverName,
  toolName,
  toolUseId,
  agentId,
  parentAbortController,
  autoBackgroundMs,
  setAppState,
  hasPendingElicitation,
  onBackgrounded,
  describeResult,
  buildBackgroundedResult,
  registerTask = registerMcpBackgroundTask,
  settleTask = settleMcpBackgroundTask,
}: McpAutoBackgroundOptions<T>): Promise<T> {
  // Detached controller: the call outlives the turn once it is backgrounded.
  const callAbortController = new AbortController()
  const detachRelay = attachDetachableAbortRelay(
    parentAbortController,
    callAbortController,
  )
  const startedAt = Date.now()
  const call = run(callAbortController.signal)
  // A separate settled-marker promise: awaiting `call` directly in the race would make
  // an early rejection escape as an unhandled rejection of the race itself.
  const settled = call.then(
    () => 'settled' as const,
    () => 'settled' as const,
  )

  const timerAbort = new AbortController()
  try {
    for (;;) {
      const outcome = await Promise.race([
        settled,
        sleep(autoBackgroundMs, timerAbort.signal).then(
          () => 'timeout' as const,
        ),
      ])
      if (outcome === 'settled' || parentAbortController.signal.aborted) {
        detachRelay()
        return await call
      }
      // Blocked on the user, not on the server — give it another full interval.
      if (hasPendingElicitation?.()) continue
      break
    }
  } finally {
    timerAbort.abort()
  }

  detachRelay()

  const description = `${serverName} · ${toolName}`
  const taskId = registerTask(setAppState, {
    description,
    serverName,
    toolName,
    ...(toolUseId ? { toolUseId } : {}),
    ...(agentId ? { agentId } : {}),
    abortController: callAbortController,
  })
  onBackgrounded?.(taskId)
  // No server/tool names in the payload: `LogEventMetadata` rejects bare strings
  // precisely because MCP-supplied identifiers can carry paths. Upstream logs {} here
  // too; the names live in the debug log below, which stays local.
  logEvent('tengu_mcp_tool_auto_backgrounded', {
    auto_background_ms: autoBackgroundMs,
  })
  logForDebugging(
    `[mcp] auto-backgrounded ${description} as task ${taskId} after ${autoBackgroundMs}ms`,
  )

  // Deliberately not awaited: the whole point is to return to the model now.
  void call.then(
    value => {
      settleTask(taskId, setAppState, {
        status: 'completed',
        serverName,
        toolName,
        agentId,
        toolUseId,
        resultText: safeDescribe(describeResult, value),
      })
    },
    error => {
      settleTask(taskId, setAppState, {
        status: 'failed',
        serverName,
        toolName,
        agentId,
        toolUseId,
        resultText: error instanceof Error ? error.message : String(error),
      })
    },
  )

  const elapsedSeconds = Math.max(
    1,
    Math.round((Date.now() - startedAt) / 1000),
  )
  return buildBackgroundedResult({ taskId, elapsedSeconds })
}

/**
 * The result renderer is caller-supplied and runs on an arbitrary MCP payload, so a
 * throw there must not turn a completed task into a failed one.
 */
function safeDescribe<T>(describe: (value: T) => string, value: T): string {
  try {
    return describe(value)
  } catch (error) {
    return `(the MCP result could not be rendered: ${
      error instanceof Error ? error.message : String(error)
    })`
  }
}

/**
 * Flattens an MCP result into the plain text stored for a backgrounded call.
 *
 * Non-text blocks become a labelled placeholder rather than being dropped: the model
 * reading this later needs to know an image came back, even though the bytes are no
 * longer attachable to a tool result that has already been answered.
 */
export function mcpContentToText(content: MCPToolResult): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map(block =>
      block.type === 'text' ? block.text : `[${block.type} content omitted]`,
    )
    .join('\n')
}

/**
 * Message handed to the model in place of the result it was waiting for.
 *
 * Wording is upstream's, and every clause in it is doing work: that the call is still
 * alive (not cancelled), that a notification is coming (so the model should not poll),
 * that it can proceed (so it does not stall), how to stop it, and that the task dies
 * with the session (so it does not promise the user tomorrow's results).
 */
export function mcpBackgroundedMessage(
  description: string,
  taskId: string,
  elapsedSeconds: number,
): string {
  return `MCP tool "${description}" is still running after ${elapsedSeconds}s. It was moved to the background as task ${taskId} and keeps running; you'll receive a notification with the result when it completes. You can keep working in the meantime. To stop it, use TaskStop with task_id "${taskId}". Note: it does not survive exiting this session.`
}
