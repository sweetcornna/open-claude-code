/**
 * Total wall-clock budget for one agent run. **Disabled by default** — only a
 * positive `CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS` turns it on.
 *
 * It used to default to 30 minutes, which is a hard ceiling on *legitimate*
 * work: an agent that is steadily producing tool results, waiting on a
 * permission prompt, or coordinating its own sub-agents gets killed for taking
 * a long time rather than for being stuck. "Stuck" is what the no-progress
 * limit below detects, and it detects it far more precisely. A wall-clock cap
 * is a policy knob (budget/CI), not a health check, so it ships off.
 */
const DEFAULT_AGENT_TOTAL_TIMEOUT_MS = 0

/**
 * How long an agent may run without a single tool result before it is
 * considered wedged. 40 minutes.
 *
 * Raised from 5 minutes: that window is shorter than several perfectly normal
 * pauses. The API retry chain alone (10 attempts with exponential backoff as of
 * 2.35.0) can legitimately burn 15-20 minutes, and the no-progress timer does
 * not renew during a retry countdown — so a 5-minute window fired *inside* a
 * healthy retry chain and blamed the agent for a network problem, pointing the
 * user at the wrong knob. 40 minutes covers a full retry chain end-to-end and
 * still catches the failure this exists for (an agent looping on text with no
 * tool call ever completing).
 */
const DEFAULT_AGENT_NO_PROGRESS_TIMEOUT_MS = 40 * 60 * 1000

const AGENT_TOTAL_TIMEOUT_ENV = 'CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS'
const AGENT_NO_PROGRESS_TIMEOUT_ENV = 'CLAUDE_CODE_AGENT_NO_PROGRESS_TIMEOUT_MS'

type AgentExecutionLimitKind = 'total-timeout' | 'no-progress'

type AgentExecutionTimeouts = {
  totalTimeoutMs: number
  noProgressTimeoutMs: number
}

type AgentExecutionWatchdogScheduler = {
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

const scheduler: AgentExecutionWatchdogScheduler = {
  setTimeout: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref?.()
    return timer
  },
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

function parseTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

/**
 * `0` (or a negative/unparseable value falling back to a `0` default) disables
 * a limit entirely, so the total budget is off unless the env var names a
 * positive number.
 */
function getAgentExecutionTimeouts(): AgentExecutionTimeouts {
  return {
    totalTimeoutMs: parseTimeout(
      AGENT_TOTAL_TIMEOUT_ENV,
      DEFAULT_AGENT_TOTAL_TIMEOUT_MS,
    ),
    noProgressTimeoutMs: parseTimeout(
      AGENT_NO_PROGRESS_TIMEOUT_ENV,
      DEFAULT_AGENT_NO_PROGRESS_TIMEOUT_MS,
    ),
  }
}

export class AgentExecutionLimitError extends Error {
  readonly name = 'AgentExecutionLimitError'

  constructor(
    readonly kind: AgentExecutionLimitKind,
    readonly timeoutMs: number,
  ) {
    const envName =
      kind === 'total-timeout'
        ? AGENT_TOTAL_TIMEOUT_ENV
        : AGENT_NO_PROGRESS_TIMEOUT_ENV
    const description =
      kind === 'total-timeout'
        ? 'total execution time'
        : 'time without tool progress'
    super(
      `Agent exceeded ${description} limit (${timeoutMs}ms). Set ${envName} to adjust it, or 0 to disable it.`,
    )
  }
}

export function isAgentExecutionLimitError(
  error: unknown,
): error is AgentExecutionLimitError {
  if (error instanceof AgentExecutionLimitError) return true
  if (typeof error !== 'object' || error === null) return false
  const value = error as { name?: unknown; kind?: unknown; timeoutMs?: unknown }
  return (
    value.name === 'AgentExecutionLimitError' &&
    (value.kind === 'total-timeout' || value.kind === 'no-progress') &&
    typeof value.timeoutMs === 'number'
  )
}

function getContentBlocks(message: unknown): Array<Record<string, unknown>> {
  if (typeof message !== 'object' || message === null) return []
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  if (!Array.isArray(content)) return []
  return content.filter(
    (block): block is Record<string, unknown> =>
      typeof block === 'object' && block !== null,
  )
}

export class AgentExecutionWatchdog {
  private readonly activeToolUseIds = new Set<string>()
  private totalTimer: unknown
  private noProgressTimer: unknown
  private disposed = false
  private trippedError: AgentExecutionLimitError | undefined

  constructor(
    private readonly abortController: AbortController,
    private readonly timeouts = getAgentExecutionTimeouts(),
    private readonly timerScheduler = scheduler,
    totalElapsedMs = 0,
  ) {
    if (timeouts.totalTimeoutMs > 0) {
      const remainingMs = Math.max(
        0,
        timeouts.totalTimeoutMs - Math.max(0, totalElapsedMs),
      )
      if (remainingMs === 0) {
        this.trip('total-timeout', timeouts.totalTimeoutMs)
      } else {
        this.totalTimer = timerScheduler.setTimeout(
          () => this.trip('total-timeout', timeouts.totalTimeoutMs),
          remainingMs,
        )
      }
    }
    this.restartNoProgressTimer()
  }

  observe(message: unknown): void {
    if (this.disposed || this.trippedError) return
    if (typeof message !== 'object' || message === null) return

    const type = (message as { type?: unknown }).type

    // A tombstone retracts an assistant message that was already yielded — the
    // streaming-fallback path in query.ts emits one per orphaned message and
    // never sends a tool_result for the tool_use blocks inside them. Without
    // this branch those ids stay in activeToolUseIds forever, the set never
    // returns to empty, and the no-progress timer is permanently suspended:
    // the watchdog silently stops watching for the rest of the run.
    if (type === 'tombstone') {
      const tombstoned = (message as { message?: unknown }).message
      let toolRetracted = false
      for (const block of getContentBlocks(tombstoned)) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
        toolRetracted = this.activeToolUseIds.delete(block.id) || toolRetracted
      }
      if (toolRetracted && this.activeToolUseIds.size === 0) {
        this.restartNoProgressTimer()
      }
      return
    }

    const blocks = getContentBlocks(message)
    if (type === 'assistant') {
      let toolStarted = false
      for (const block of blocks) {
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue
        this.activeToolUseIds.add(block.id)
        toolStarted = true
      }
      if (toolStarted) this.clearNoProgressTimer()
      return
    }

    if (type !== 'user') return
    let toolCompleted = false
    for (const block of blocks) {
      if (
        block.type !== 'tool_result' ||
        typeof block.tool_use_id !== 'string'
      ) {
        continue
      }
      toolCompleted =
        this.activeToolUseIds.delete(block.tool_use_id) || toolCompleted
    }
    if (toolCompleted && this.activeToolUseIds.size === 0) {
      this.restartNoProgressTimer()
    }
  }

  get error(): AgentExecutionLimitError | undefined {
    return this.trippedError
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.totalTimer !== undefined) {
      this.timerScheduler.clearTimeout(this.totalTimer)
      this.totalTimer = undefined
    }
    this.clearNoProgressTimer()
    this.activeToolUseIds.clear()
  }

  private restartNoProgressTimer(): void {
    this.clearNoProgressTimer()
    if (
      this.disposed ||
      this.trippedError ||
      this.activeToolUseIds.size > 0 ||
      this.timeouts.noProgressTimeoutMs <= 0
    ) {
      return
    }
    this.noProgressTimer = this.timerScheduler.setTimeout(
      () => this.trip('no-progress', this.timeouts.noProgressTimeoutMs),
      this.timeouts.noProgressTimeoutMs,
    )
  }

  private clearNoProgressTimer(): void {
    if (this.noProgressTimer === undefined) return
    this.timerScheduler.clearTimeout(this.noProgressTimer)
    this.noProgressTimer = undefined
  }

  private trip(kind: AgentExecutionLimitKind, timeoutMs: number): void {
    if (
      this.disposed ||
      this.trippedError ||
      this.abortController.signal.aborted
    ) {
      return
    }
    this.trippedError = new AgentExecutionLimitError(kind, timeoutMs)
    this.abortController.abort(this.trippedError)
  }
}
