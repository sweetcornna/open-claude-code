import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { errorResult, okJson } from './core.js'
import type { CuCallToolResult } from './core.js'
import { releaseHeldMouse } from './mouse.js'
import { sleep } from './timing.js'

// ---------------------------------------------------------------------------
// Batch dispatch
// ---------------------------------------------------------------------------

/**
 * Actions allowed inside a computer_batch call. Excludes request_access,
 * open_application, clipboard, list_granted (no latency benefit, complicates
 * security model).
 */
export const BATCHABLE_ACTIONS: ReadonlySet<string> = new Set([
  'key',
  'type',
  'mouse_move',
  'left_click',
  'left_click_drag',
  'right_click',
  'middle_click',
  'double_click',
  'triple_click',
  'scroll',
  'hold_key',
  'screenshot',
  'cursor_position',
  'left_mouse_down',
  'left_mouse_up',
  'wait',
])

export interface BatchActionResult {
  action: string
  ok: boolean
  output: string
}

/**
 * Executes `actions: [{action, …}, …]`
 * sequentially in ONE model→API round trip — the dominant latency cost
 * (seconds, vs. ~50ms local overhead per action).
 *
 * Gate semantics (the security model):
 *   - Kill-switch + TCC: checked ONCE by handleToolCall before reaching here.
 *   - prepareForAction: run ONCE at the top. The user approved "do this
 *     sequence"; hiding apps per-action is wasted work and fast-pathed anyway.
 *   - Frontmost gate: checked PER ACTION. State can change mid-batch — a
 *     click might open a non-allowed app. This is the safety net: if action
 *     3 of 5 opened Safari (not allowed), action 4's frontmost check fires
 *     and stops the batch there.
 *   - PixelCompare: SKIPPED inside batch. The model committed to the full
 *     sequence without intermediate screenshots; validating mid-batch clicks
 *     against a pre-batch screenshot would false-positive constantly.
 *
 * Both skips are implemented by passing `{...subGates, hideBeforeAction:
 * false, pixelValidation: false}` to each inner dispatch — the handlers'
 * existing gate logic does the right thing, no new code paths.
 *
 * Stop-on-first-error: accumulate results, on
 * first `isError` stop executing, return everything so far + the error. The
 * model sees exactly where the batch broke and what succeeded before it.
 *
 * Mid-batch screenshots are allowed (for inspection) but NEVER piggyback —
 * their `.screenshot` field is dropped. Same invariant as zoom: click coords
 * always refer to the PRE-BATCH `lastScreenshot`. If the model wants to click
 * based on a new screenshot, it ends the batch and screenshots separately.
 */
/**
 * Executes one inner action of a batch. Injected by dispatch.ts so this
 * module never imports the dispatcher back (would be an import cycle).
 */
export type BatchActionDispatcher = (
  action: string,
  args: Record<string, unknown>,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
) => Promise<CuCallToolResult>

export async function handleComputerBatch(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  dispatchAction: BatchActionDispatcher,
): Promise<CuCallToolResult> {
  const actions = args.actions
  if (!Array.isArray(actions) || actions.length === 0) {
    return errorResult('actions must be a non-empty array', 'bad_args')
  }

  for (const [i, act] of actions.entries()) {
    if (typeof act !== 'object' || act === null) {
      return errorResult(`actions[${i}] must be an object`, 'bad_args')
    }
    const action = (act as Record<string, unknown>).action
    if (typeof action !== 'string') {
      return errorResult(`actions[${i}].action must be a string`, 'bad_args')
    }
    if (!BATCHABLE_ACTIONS.has(action)) {
      return errorResult(
        `actions[${i}].action="${action}" is not allowed in a batch. ` +
          `Allowed: ${[...BATCHABLE_ACTIONS].join(', ')}.`,
        'bad_args',
      )
    }
  }

  // prepareForAction ONCE. After this, inner dispatches skip it via
  // hideBeforeAction:false.
  if (subGates.hideBeforeAction) {
    const hidden = await adapter.executor.prepareForAction(
      overrides.allowedApps.map(a => a.bundleId),
      overrides.selectedDisplayId,
    )
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden)
    }
  }

  // Inner actions: skip prepare (already ran), skip pixelCompare (stale by
  // design). Frontmost still checked — runInputActionGates does it
  // unconditionally.
  const batchSubGates: CuSubGates = {
    ...subGates,
    hideBeforeAction: false,
    pixelValidation: false,
    // Batch already took its screenshot (appended at end); a mid-batch
    // resolver switch would make that screenshot inconsistent with
    // earlier clicks' lastScreenshot-based scaleCoord targeting.
    autoTargetDisplay: false,
  }

  const results: BatchActionResult[] = []
  for (const [i, act] of actions.entries()) {
    // Overlay Stop → host's stopSession → lifecycleState leaves "running"
    // synchronously before query.interrupt(). The SDK abort tears down the
    // host's await but not this loop — without this check the remaining
    // actions fire into a dead session.
    if (overrides.isAborted?.()) {
      await releaseHeldMouse(adapter)
      return errorResult(
        `Batch aborted after ${results.length} of ${actions.length} actions (user interrupt).`,
      )
    }

    // Small inter-step settle. Synthetic CGEvents post instantly; some apps
    // need a tick to process step N's input before step N+1 lands (e.g. a
    // click opening a menu before the next click targets a menu item).
    if (i > 0) await sleep(10)

    const actionArgs = act as Record<string, unknown>
    const action = actionArgs.action as string

    // Drop mid-batch screenshot piggyback (strip .screenshot). Click coords
    // stay anchored to the pre-batch lastScreenshot.
    const { screenshot: _dropped, ...inner } = await dispatchAction(
      action,
      actionArgs,
      adapter,
      overrides,
      batchSubGates,
    )

    const text = firstTextContent(inner)
    const result = { action, ok: !inner.isError, output: text }
    results.push(result)

    if (inner.isError) {
      // Stop-on-first-error. Return everything so far + the error.
      // Forward the inner action's telemetry (error_kind) so cu_tool_call
      // reflects the actual failure — without this, batch-internal errors
      // emit error_kind: undefined despite the inner handler tagging it.
      // Release held mouse: the error may be a mid-grapheme abort in
      // handleType, or a frontmost gate, landing between mouse_down and
      // mouse_up.
      await releaseHeldMouse(adapter)
      return okJson(
        {
          completed: results.slice(0, -1),
          failed: result,
          remaining: actions.length - results.length,
        },
        inner.telemetry,
      )
    }
  }

  return okJson({ completed: results })
}

export function firstTextContent(r: CuCallToolResult): string {
  const first = r.content[0]
  return first && first.type === 'text' ? first.text : ''
}
