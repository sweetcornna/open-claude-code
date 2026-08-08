import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  AgentExecutionWatchdog,
  isAgentExecutionLimitError,
} from '../agentExecutionWatchdog.js'

class FakeScheduler {
  private now = 0
  private nextId = 0
  private readonly timers = new Map<
    number,
    { callback: () => void; deadline: number }
  >()

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId
    this.timers.set(id, { callback, deadline: this.now + delayMs })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number)
  }

  pendingDelays(): number[] {
    return [...this.timers.values()]
      .map(timer => timer.deadline - this.now)
      .sort((left, right) => left - right)
  }

  advance(ms: number): void {
    const target = this.now + ms
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= target)
        .sort((a, b) => a[1].deadline - b[1].deadline)[0]
      if (!due) break
      this.now = due[1].deadline
      this.timers.delete(due[0])
      due[1].callback()
    }
    this.now = target
  }
}

const ENV_KEYS = [
  'CLAUDE_CODE_AGENT_TOTAL_TIMEOUT_MS',
  'CLAUDE_CODE_AGENT_NO_PROGRESS_TIMEOUT_MS',
] as const
const savedEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
)

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key]
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('agent execution timeout configuration', () => {
  test('defaults to no-progress only, and supports overrides and disabling', () => {
    // Out of the box there is exactly one timer: the 40-minute no-progress
    // window. The total wall-clock budget is off, because it kills agents that
    // are working, not agents that are stuck.
    const defaults = new FakeScheduler()
    new AgentExecutionWatchdog(new AbortController(), undefined, defaults)
    expect(defaults.pendingDelays()).toEqual([40 * 60 * 1000])

    process.env[ENV_KEYS[0]] = '1200'
    process.env[ENV_KEYS[1]] = '0'
    const overridden = new FakeScheduler()
    new AgentExecutionWatchdog(new AbortController(), undefined, overridden)
    expect(overridden.pendingDelays()).toEqual([1200])

    // A positive value is the only thing that turns the total budget on;
    // garbage falls back to the default, which is "disabled".
    process.env[ENV_KEYS[0]] = '-1'
    process.env[ENV_KEYS[1]] = 'invalid'
    const invalid = new FakeScheduler()
    new AgentExecutionWatchdog(new AbortController(), undefined, invalid)
    expect(invalid.pendingDelays()).toEqual([40 * 60 * 1000])
  })
})

describe('AgentExecutionWatchdog', () => {
  test('placeholder assistant text does not reset semantic progress', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 0, noProgressTimeoutMs: 100 },
      scheduler,
    )

    scheduler.advance(90)
    watchdog.observe({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Querying...' }] },
    })
    scheduler.advance(10)

    expect(controller.signal.aborted).toBe(true)
    expect(isAgentExecutionLimitError(controller.signal.reason)).toBe(true)
    expect(controller.signal.reason.kind).toBe('no-progress')
  })

  test('active tools pause no-progress until the final result', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 0, noProgressTimeoutMs: 100 },
      scheduler,
    )

    scheduler.advance(90)
    watchdog.observe({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1' },
          { type: 'tool_use', id: 'tool-2' },
        ],
      },
    })
    scheduler.advance(1000)
    expect(controller.signal.aborted).toBe(false)

    watchdog.observe({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] },
    })
    scheduler.advance(1000)
    expect(controller.signal.aborted).toBe(false)

    watchdog.observe({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2' }] },
    })
    scheduler.advance(99)
    expect(controller.signal.aborted).toBe(false)
    scheduler.advance(1)
    expect(controller.signal.reason.kind).toBe('no-progress')
  })

  test('a tombstoned assistant message releases its tool_use ids', () => {
    // query.ts's streaming-fallback path retracts the orphaned assistant
    // messages with tombstones and never sends tool_results for the tool_use
    // blocks inside them. Treating the tombstone as an unrelated message left
    // those ids pinned in activeToolUseIds, so the no-progress timer stayed
    // suspended for the rest of the run — the watchdog quietly stopped
    // watching precisely when the run had already gone wrong once.
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 0, noProgressTimeoutMs: 100 },
      scheduler,
    )

    const orphaned = {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'tool-1' },
          { type: 'tool_use', id: 'tool-2' },
        ],
      },
    }
    watchdog.observe(orphaned)
    scheduler.advance(1000)
    expect(controller.signal.aborted).toBe(false)

    watchdog.observe({ type: 'tombstone', message: orphaned })
    // Back to "no tools in flight", so the window restarts from here rather
    // than never firing again.
    scheduler.advance(99)
    expect(controller.signal.aborted).toBe(false)
    scheduler.advance(1)
    expect(controller.signal.reason.kind).toBe('no-progress')
  })

  test('a tombstone with a still-active sibling tool keeps the timer paused', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 0, noProgressTimeoutMs: 100 },
      scheduler,
    )

    const orphaned = {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1' }] },
    }
    watchdog.observe(orphaned)
    watchdog.observe({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-2' }] },
    })
    watchdog.observe({ type: 'tombstone', message: orphaned })

    scheduler.advance(1000)
    expect(controller.signal.aborted).toBe(false)

    watchdog.observe({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool-2' }] },
    })
    scheduler.advance(100)
    expect(controller.signal.reason.kind).toBe('no-progress')
  })

  test('total timeout still stops a long-running active tool', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 100, noProgressTimeoutMs: 10 },
      scheduler,
    )

    watchdog.observe({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'tool-1' }] },
    })
    scheduler.advance(100)

    expect(controller.signal.reason.kind).toBe('total-timeout')
  })

  test('preserves the total deadline across execution handoff', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 100, noProgressTimeoutMs: 0 },
      scheduler,
      80,
    )

    scheduler.advance(19)
    expect(controller.signal.aborted).toBe(false)
    scheduler.advance(1)
    expect(controller.signal.reason.kind).toBe('total-timeout')
  })

  test('disposal cancels both limits', () => {
    const scheduler = new FakeScheduler()
    const controller = new AbortController()
    const watchdog = new AgentExecutionWatchdog(
      controller,
      { totalTimeoutMs: 100, noProgressTimeoutMs: 50 },
      scheduler,
    )

    watchdog.dispose()
    scheduler.advance(1000)
    expect(controller.signal.aborted).toBe(false)
  })
})
