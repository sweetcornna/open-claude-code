import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { scaleCoord } from './coordinates.js'
import { errorResult, extractCoordinate, okText } from './core.js'
import type { CuCallToolResult } from './core.js'
import { runHitTestGate, runInputActionGates } from './inputGates.js'
import type { CuActionKind } from './inputGates.js'

// ---------------------------------------------------------------------------
// left_mouse_down / left_mouse_up held-state tracking
// ---------------------------------------------------------------------------

/**
 * Errors on double-down but not on up-without-down. Module-level, but
 * reset on every lock acquire (handleToolCall → acquireCuLock branch) so
 * a session interrupted mid-drag (overlay stop during left_mouse_down)
 * doesn't leave the flag true for the next lock holder.
 *
 * Still scoped wrong within a single lock cycle if sessions could interleave
 * tool calls, but the lock enforces at-most-one-session-uses-CU so they
 * can't. The per-turn reset is the correctness boundary.
 */
export let mouseButtonHeld = false

/** Whether mouse_move occurred between left_mouse_down and left_mouse_up.
 *  When false at mouseUp, the decomposed sequence is a click-release (not a
 *  drop) — hit-test at "mouse", not "mouse_full". */
export let mouseMoved = false

/** Clears the cross-call drag flags. Called from Gate-3 on lock-acquire and
 *  from `bindSessionContext` in mcpServer.ts — a fresh lock holder must not
 *  inherit a prior session's mid-drag state. */
export function resetMouseButtonHeld(): void {
  mouseButtonHeld = false
  mouseMoved = false
}

/** If a left_mouse_down set the OS button without a matching left_mouse_up
 *  ever getting its turn, release it now. Same release-before-return as
 *  handleClick. No-op when not held — callers don't need to check. */
export async function releaseHeldMouse(
  adapter: ComputerUseHostAdapter,
): Promise<void> {
  if (!mouseButtonHeld) return
  await adapter.executor.mouseUp()
  mouseButtonHeld = false
  mouseMoved = false
}

export async function handleScroll(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const coord = extractCoordinate(args)
  if (coord instanceof Error) return errorResult(coord.message, 'bad_args')
  const [rawX, rawY] = coord

  // Uses scroll_direction + scroll_amount.
  // Map to our dx/dy executor interface.
  const dir = args.scroll_direction
  if (dir !== 'up' && dir !== 'down' && dir !== 'left' && dir !== 'right') {
    return errorResult(
      "scroll_direction must be 'up', 'down', 'left', or 'right'",
      'bad_args',
    )
  }
  const amount = args.scroll_amount
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount < 0) {
    return errorResult('scroll_amount must be a non-negative int', 'bad_args')
  }
  if (amount > 100) {
    return errorResult('scroll_amount exceeds maximum of 100', 'bad_args')
  }
  // up → dy = -amount; down → dy = +amount; left → dx = -amount; right → dx = +amount.
  const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0
  const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0

  const gate = await runInputActionGates(adapter, overrides, subGates, 'mouse')
  if (gate) return gate

  const display = await adapter.executor.getDisplaySize(
    overrides.selectedDisplayId,
  )
  const { x, y } = scaleCoord(
    rawX,
    rawY,
    overrides.coordinateMode,
    display,
    overrides.lastScreenshot,
    adapter.logger,
  )

  // When the button is held, executor.scroll's internal moveMouse generates
  // a leftMouseDragged event (enigo reads NSEvent.pressedMouseButtons) —
  // same mechanism as handleMoveMouse's held-button path. Upgrade the
  // hit-test to "mouse_full" so scroll can't be used to drag-drop text onto
  // a click-tier terminal, and mark mouseMoved so the subsequent
  // left_mouse_up hit-tests as a drop not a click-release.
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    x,
    y,
    mouseButtonHeld ? 'mouse_full' : 'mouse',
  )
  if (hitGate) return hitGate
  if (mouseButtonHeld) mouseMoved = true

  await adapter.executor.scroll(x, y, dx, dy)
  return okText('Scrolled.')
}

export async function handleDrag(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // executor.drag() does its own press+release internally. Without this
  // defensive clear, a prior left_mouse_down leaves mouseButtonHeld=true
  // across the drag and desyncs the flag from OS state — same mechanism as
  // the handleClickVariant clear above. Release first so drag() gets a
  // clean slate.
  if (mouseButtonHeld) {
    await adapter.executor.mouseUp()
    mouseButtonHeld = false
    mouseMoved = false
  }

  // `coordinate` is the END point
  // (required). `start_coordinate` is OPTIONAL — when omitted, drag from
  // current cursor position.
  const endCoord = extractCoordinate(args, 'coordinate')
  if (endCoord instanceof Error)
    return errorResult(endCoord.message, 'bad_args')
  const rawTo = endCoord

  let rawFrom: [number, number] | undefined
  if (args.start_coordinate !== undefined) {
    const startCoord = extractCoordinate(args, 'start_coordinate')
    if (startCoord instanceof Error)
      return errorResult(startCoord.message, 'bad_args')
    rawFrom = startCoord
  }
  // else: rawFrom stays undefined → executor drags from current cursor.

  const gate = await runInputActionGates(adapter, overrides, subGates, 'mouse')
  if (gate) return gate

  const display = await adapter.executor.getDisplaySize(
    overrides.selectedDisplayId,
  )
  const from =
    rawFrom === undefined
      ? undefined
      : scaleCoord(
          rawFrom[0],
          rawFrom[1],
          overrides.coordinateMode,
          display,
          overrides.lastScreenshot,
          adapter.logger,
        )
  const to = scaleCoord(
    rawTo[0],
    rawTo[1],
    overrides.coordinateMode,
    display,
    overrides.lastScreenshot,
    adapter.logger,
  )

  // Check both drag endpoints. `from` is where the mouseDown happens (picks
  // up), `to` is where mouseUp happens (drops). When start_coordinate is
  // omitted the drag begins at the cursor — same bypass as mouse_move →
  // left_mouse_down, so read the cursor and hit-test it (mirrors
  // handleLeftMouseDown).
  //
  // The `to` endpoint uses "mouse_full" (not "mouse"): dropping text onto a
  // terminal inserts it as if typed (macOS text drag-drop). Same threat as
  // right-click→Paste. `from` stays "mouse" — picking up is a read.
  const fromPoint = from ?? (await adapter.executor.getCursorPosition())
  const fromGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    fromPoint.x,
    fromPoint.y,
    'mouse',
  )
  if (fromGate) return fromGate
  const toGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    to.x,
    to.y,
    'mouse_full',
  )
  if (toGate) return toGate

  await adapter.executor.drag(from, to)
  return okText('Dragged.')
}

export async function handleMoveMouse(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const coord = extractCoordinate(args)
  if (coord instanceof Error) return errorResult(coord.message, 'bad_args')
  const [rawX, rawY] = coord

  // When the button is held, moveMouse generates leftMouseDragged events on
  // the window under the cursor — that's interaction, not positioning.
  // Upgrade to "mouse" and hit-test the destination. When the button is NOT
  // held: pure positioning, passes at any tier, no hit-test (mouseDown/Up
  // hit-test the cursor to close the mouse_move→left_mouse_down decomposition).
  const actionKind: CuActionKind = mouseButtonHeld ? 'mouse' : 'mouse_position'
  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    actionKind,
  )
  if (gate) return gate

  const display = await adapter.executor.getDisplaySize(
    overrides.selectedDisplayId,
  )
  const { x, y } = scaleCoord(
    rawX,
    rawY,
    overrides.coordinateMode,
    display,
    overrides.lastScreenshot,
    adapter.logger,
  )

  if (mouseButtonHeld) {
    // "mouse_full" — same as left_click_drag's to-endpoint. Dragging onto a
    // click-tier terminal is text injection regardless of which primitive
    // (atomic drag vs. decomposed down/move/up) delivers the events.
    const hitGate = await runHitTestGate(
      adapter,
      overrides,
      subGates,
      x,
      y,
      'mouse_full',
    )
    if (hitGate) return hitGate
  }

  await adapter.executor.moveMouse(x, y)
  if (mouseButtonHeld) mouseMoved = true
  return okText('Moved.')
}

/**
 * Raw press at current cursor, no coordinate.
 * Move first with mouse_move. Errors if already held.
 */
export async function handleLeftMouseDown(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  if (mouseButtonHeld) {
    return errorResult(
      'mouse button already held, call left_mouse_up first',
      'state_conflict',
    )
  }

  const gate = await runInputActionGates(adapter, overrides, subGates, 'mouse')
  if (gate) return gate

  // macOS routes mouseDown to the window under the cursor, not the frontmost
  // app. Without this hit-test, mouse_move (positioning, passes at any tier)
  // + left_mouse_down decomposes a click that lands on a tier-"read" window
  // overlapping a tier-"full" frontmost app — bypassing runHitTestGate's
  // whole purpose. All three are batchable, so the bypass is atomic.
  const cursor = await adapter.executor.getCursorPosition()
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    cursor.x,
    cursor.y,
    'mouse',
  )
  if (hitGate) return hitGate

  await adapter.executor.mouseDown()
  mouseButtonHeld = true
  mouseMoved = false
  return okText('Mouse button pressed.')
}

/**
 * Raw release at current cursor. Does NOT error
 * if not held (idempotent release).
 */
export async function handleLeftMouseUp(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // Any gate rejection here must release the button FIRST — otherwise the
  // OS button stays pressed and mouseButtonHeld stays true. Recovery
  // attempts (mouse_move back to a safe app) would generate leftMouseDragged
  // events into whatever window is under the cursor, including the very
  // read-tier window the gate was protecting. A single mouseUp on a
  // restricted window is one event; a stuck button is cascading damage.
  //
  // This includes the frontmost gate: focus can change between mouseDown and
  // mouseUp (something else grabbed focus), in which case runInputActionGates
  // rejects here even though it passed at mouseDown.
  const releaseFirst = async (
    err: CuCallToolResult,
  ): Promise<CuCallToolResult> => {
    await adapter.executor.mouseUp()
    mouseButtonHeld = false
    mouseMoved = false
    return err
  }

  const gate = await runInputActionGates(adapter, overrides, subGates, 'mouse')
  if (gate) return releaseFirst(gate)

  // When the cursor moved since mouseDown, this is a drop (text-injection
  // vector) — hit-test at "mouse_full" same as left_click_drag's `to`. When
  // NO move happened, this is a click-release — same semantics as the atomic
  // left_click, hit-test at "mouse". Without this distinction, a decomposed
  // click on a click-tier app fails here while the atomic left_click works,
  // and releaseFirst fires mouseUp anyway so the OS sees a complete click
  // while the model gets a misleading error.
  const cursor = await adapter.executor.getCursorPosition()
  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    cursor.x,
    cursor.y,
    mouseMoved ? 'mouse_full' : 'mouse',
  )
  if (hitGate) return releaseFirst(hitGate)

  await adapter.executor.mouseUp()
  mouseButtonHeld = false
  mouseMoved = false
  return okText('Mouse button released.')
}
