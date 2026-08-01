import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
  TeachStepRequest,
} from '../types.js'
import { BATCHABLE_ACTIONS, firstTextContent } from './batch.js'
import type { BatchActionResult } from './batch.js'
import { scaleCoord } from './coordinates.js'
import { errorResult, okJson, requireString } from './core.js'
import type { CuCallTelemetry, CuCallToolResult } from './core.js'
import { dispatchAction } from './dispatch.js'
import { releaseHeldMouse } from './mouse.js'
import { handleScreenshot } from './screenshot.js'
import { sleep } from './timing.js'

// ---------------------------------------------------------------------------
// teach_step + teach_batch — shared step primitives
// ---------------------------------------------------------------------------

/** A fully-validated teach step, anchor already scaled to logical points. */
export interface ValidatedTeachStep {
  explanation: string
  nextPreview: string
  anchorLogical: TeachStepRequest['anchorLogical']
  actions: Array<Record<string, unknown>>
}

/**
 * Validate one raw step record and scale its anchor. `label` is prefixed to
 * error messages so teach_batch can say `steps[2].actions[0]` instead of
 * just `actions[0]`.
 *
 * The anchor transform is the whole coordinate story: model sends image-pixel
 * coords (same space as click coords, per COORDINATES.md), `scaleCoord` turns
 * them into logical points against `overrides.lastScreenshot`. For
 * teach_batch, lastScreenshot stays at its pre-call value for the entire
 * batch — same invariant as computer_batch's "coordinates refer to the
 * PRE-BATCH screenshot". Anchors for step 2+ must therefore target elements
 * the model can predict will be at those coordinates after step 1's actions.
 */
export async function validateTeachStepArgs(
  raw: Record<string, unknown>,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  label: string,
): Promise<ValidatedTeachStep | Error> {
  const explanation = requireString(raw, 'explanation')
  if (explanation instanceof Error) {
    return new Error(`${label}: ${explanation.message}`)
  }
  const nextPreview = requireString(raw, 'next_preview')
  if (nextPreview instanceof Error) {
    return new Error(`${label}: ${nextPreview.message}`)
  }

  const actions = raw.actions
  if (!Array.isArray(actions)) {
    return new Error(`${label}: "actions" must be an array (empty is allowed).`)
  }
  for (const [i, act] of actions.entries()) {
    if (typeof act !== 'object' || act === null) {
      return new Error(`${label}: actions[${i}] must be an object`)
    }
    const action = (act as Record<string, unknown>).action
    if (typeof action !== 'string') {
      return new Error(`${label}: actions[${i}].action must be a string`)
    }
    if (!BATCHABLE_ACTIONS.has(action)) {
      return new Error(
        `${label}: actions[${i}].action="${action}" is not allowed. ` +
          `Allowed: ${[...BATCHABLE_ACTIONS].join(', ')}.`,
      )
    }
  }

  let anchorLogical: TeachStepRequest['anchorLogical']
  if (raw.anchor !== undefined) {
    const anchor = raw.anchor
    if (
      !Array.isArray(anchor) ||
      anchor.length !== 2 ||
      typeof anchor[0] !== 'number' ||
      typeof anchor[1] !== 'number' ||
      !Number.isFinite(anchor[0]) ||
      !Number.isFinite(anchor[1])
    ) {
      return new Error(
        `${label}: "anchor" must be a [x, y] number tuple or omitted.`,
      )
    }
    const display = await adapter.executor.getDisplaySize(
      overrides.selectedDisplayId,
    )
    anchorLogical = scaleCoord(
      anchor[0],
      anchor[1],
      overrides.coordinateMode,
      display,
      overrides.lastScreenshot,
      adapter.logger,
    )
  }

  return {
    explanation,
    nextPreview,
    anchorLogical,
    actions: actions as Array<Record<string, unknown>>,
  }
}

/** Outcome of showing one tooltip + running its actions. */
export type TeachStepOutcome =
  | { kind: 'exit' }
  | { kind: 'ok'; results: BatchActionResult[] }
  | {
      kind: 'action_error'
      executed: number
      failed: BatchActionResult
      remaining: number
      /** The inner action's telemetry (error_kind), forwarded so the
       *  caller can pass it to okJson and keep cu_tool_call accurate
       *  when the failure happened inside a batch. */
      telemetry: CuCallTelemetry | undefined
    }

/**
 * Show the tooltip, block for Next/Exit, run actions on Next.
 *
 * Action execution is a straight lift from `handleComputerBatch`:
 * prepareForAction ONCE per step (the user clicked Next — they consented to
 * that step's sequence), pixelValidation OFF (committed sequence), frontmost
 * gate still per-action, stop-on-first-error with partial results.
 *
 * Empty `actions` is valid — "read this, click Next to continue" steps.
 * Assumes `overrides.onTeachStep` is set (caller guards).
 */
export async function executeTeachStep(
  step: ValidatedTeachStep,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<TeachStepOutcome> {
  // Block until Next or Exit. Same pending-promise pattern as
  // onPermissionRequest — host stores the resolver, overlay IPC fires it.
  // `!` is safe: both callers guard on overrides.onTeachStep before reaching here.
  const stepResult = await overrides.onTeachStep!({
    explanation: step.explanation,
    nextPreview: step.nextPreview,
    anchorLogical: step.anchorLogical,
  })

  if (stepResult.action === 'exit') {
    // The host's Exit handler also calls stopSession, so the turn is
    // already unwinding. Caller decides what to return for the transcript.
    // A PREVIOUS step's left_mouse_down may have left the OS button held.
    await releaseHeldMouse(adapter)
    return { kind: 'exit' }
  }

  // Next clicked. Flip overlay to spinner before we start driving.
  overrides.onTeachWorking?.()

  if (step.actions.length === 0) {
    return { kind: 'ok', results: [] }
  }

  if (subGates.hideBeforeAction) {
    const hidden = await adapter.executor.prepareForAction(
      overrides.allowedApps.map(a => a.bundleId),
      overrides.selectedDisplayId,
    )
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden)
    }
  }

  const stepSubGates: CuSubGates = {
    ...subGates,
    hideBeforeAction: false,
    pixelValidation: false,
    // Anchors are pre-computed against the display at batch start.
    // A mid-batch resolver switch would break tooltip positioning.
    autoTargetDisplay: false,
  }

  const results: BatchActionResult[] = []
  for (const [i, act] of step.actions.entries()) {
    // Same abort check as handleComputerBatch — Exit calls stopSession so
    // this IS the exit path, just caught mid-dispatch instead of at the
    // onTeachStep await above. Callers already handle { kind: "exit" }.
    if (overrides.isAborted?.()) {
      await releaseHeldMouse(adapter)
      return { kind: 'exit' }
    }
    // Same inter-step settle as handleComputerBatch.
    if (i > 0) await sleep(10)
    const action = act.action as string

    // Drop mid-step screenshot piggyback — same invariant as computer_batch.
    // Click coords stay anchored to the screenshot the model took BEFORE
    // calling teach_step/teach_batch.
    const { screenshot: _dropped, ...inner } = await dispatchAction(
      action,
      act,
      adapter,
      overrides,
      stepSubGates,
    )

    const text = firstTextContent(inner)
    const result = { action, ok: !inner.isError, output: text }
    results.push(result)

    if (inner.isError) {
      await releaseHeldMouse(adapter)
      return {
        kind: 'action_error',
        executed: results.length - 1,
        failed: result,
        remaining: step.actions.length - results.length,
        telemetry: inner.telemetry,
      }
    }
  }

  return { kind: 'ok', results }
}

/**
 * Fold a fresh screenshot into the result. Eliminates the separate
 * screenshot tool call the model would otherwise make before the next
 * teach_step (one fewer API round trip per step). handleScreenshot
 * runs its own prepareForAction — that's correct: actions may have
 * opened something outside the allowlist. The .screenshot piggyback
 * flows through to serverDef.ts's stash → lastScreenshot updates →
 * the next teach_step.anchor scales against THIS image, which is what
 * the model is now looking at.
 */
export async function appendTeachScreenshot(
  resultJson: unknown,
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const shotResult = await handleScreenshot(adapter, overrides, subGates)
  if (shotResult.isError) {
    // Hide+screenshot failed (rare — e.g. SCContentFilter error). Don't
    // tank the step; just omit the image. Model will call screenshot
    // itself and see the real error.
    return okJson(resultJson)
  }
  return {
    content: [
      { type: 'text', text: JSON.stringify(resultJson) },
      // handleScreenshot's content is [maybeMonitorNote, maybeHiddenNote,
      // image]. Spread all — both notes are useful context and the model
      // expects them alongside screenshots.
      ...shotResult.content,
    ],
    // For serverDef.ts to stash. Next teach_step.anchor scales against this.
    screenshot: shotResult.screenshot,
  }
}

/**
 * Show one guided-tour tooltip and block until the user clicks Next or Exit.
 * On Next, execute `actions[]` with `computer_batch` semantics.
 */
export async function handleTeachStep(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.onTeachStep) {
    return errorResult(
      'Teach mode is not active. Call request_teach_access first.',
      'teach_mode_not_active',
    )
  }

  const step = await validateTeachStepArgs(
    args,
    adapter,
    overrides,
    'teach_step',
  )
  if (step instanceof Error) return errorResult(step.message, 'bad_args')

  const outcome = await executeTeachStep(step, adapter, overrides, subGates)

  if (outcome.kind === 'exit') {
    return okJson({ exited: true })
  }
  if (outcome.kind === 'action_error') {
    return okJson(
      {
        executed: outcome.executed,
        failed: outcome.failed,
        remaining: outcome.remaining,
      },
      outcome.telemetry,
    )
  }

  // ok. No screenshot for empty actions — screen didn't change, model's
  // existing screenshot is still accurate.
  if (step.actions.length === 0) {
    return okJson({ executed: 0, results: [] })
  }
  return appendTeachScreenshot(
    { executed: outcome.results.length, results: outcome.results },
    adapter,
    overrides,
    subGates,
  )
}

/**
 * Queue a whole guided tour in one tool call. Parallels `computer_batch`: N
 * steps → one model→API round trip instead of N. Each step still blocks for
 * its own Next click (the user paces the tour), but the model doesn't wait
 * for a round trip between steps.
 *
 * Validates ALL steps upfront so a typo in step 5 doesn't surface after the
 * user has already clicked through steps 1–4.
 *
 * Anchors for every step scale against the pre-call `lastScreenshot` — same
 * PRE-BATCH invariant as computer_batch. Steps 2+ should either omit anchor
 * (centered tooltip) or target elements the model predicts won't have moved.
 *
 * Result shape:
 *   {exited: true, stepsCompleted: N}                   — user clicked Exit
 *   {stepsCompleted, stepFailed, executed, failed, …}   — action error at step N
 *   {stepsCompleted, results: [...]} + screenshot       — all steps ran
 */
export async function handleTeachBatch(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (!overrides.onTeachStep) {
    return errorResult(
      'Teach mode is not active. Call request_teach_access first.',
      'teach_mode_not_active',
    )
  }

  const rawSteps = args.steps
  if (!Array.isArray(rawSteps) || rawSteps.length < 1) {
    return errorResult('"steps" must be a non-empty array.', 'bad_args')
  }

  // Validate upfront — fail fast before showing any tooltip.
  const steps: ValidatedTeachStep[] = []
  for (const [i, raw] of rawSteps.entries()) {
    if (typeof raw !== 'object' || raw === null) {
      return errorResult(`steps[${i}] must be an object`, 'bad_args')
    }
    const v = await validateTeachStepArgs(
      raw as Record<string, unknown>,
      adapter,
      overrides,
      `steps[${i}]`,
    )
    if (v instanceof Error) return errorResult(v.message, 'bad_args')
    steps.push(v)
  }

  const allResults: BatchActionResult[][] = []
  for (const [i, step] of steps.entries()) {
    const outcome = await executeTeachStep(step, adapter, overrides, subGates)

    if (outcome.kind === 'exit') {
      return okJson({ exited: true, stepsCompleted: i })
    }
    if (outcome.kind === 'action_error') {
      return okJson(
        {
          stepsCompleted: i,
          stepFailed: i,
          executed: outcome.executed,
          failed: outcome.failed,
          remaining: outcome.remaining,
          results: allResults,
        },
        outcome.telemetry,
      )
    }
    allResults.push(outcome.results)
  }

  // Final screenshot only if any step ran actions (screen changed).
  const screenChanged = steps.some(s => s.actions.length > 0)
  const resultJson = { stepsCompleted: steps.length, results: allResults }
  if (!screenChanged) {
    return okJson(resultJson)
  }
  return appendTeachScreenshot(resultJson, adapter, overrides, subGates)
}
