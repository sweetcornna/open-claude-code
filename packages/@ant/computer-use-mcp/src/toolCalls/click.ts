import { isSystemKeyCombo } from '../keyBlocklist.js'
import { validateClickTarget } from '../pixelCompare.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { coordToPercentageForPixelCompare, scaleCoord } from './coordinates.js'
import { errorResult, extractCoordinate, okText } from './core.js'
import type { CuCallToolResult } from './core.js'
import { runHitTestGate, runInputActionGates } from './inputGates.js'
import type { CuActionKind } from './inputGates.js'
import { parseKeyChord } from './keyboard.js'
import { releaseHeldMouse } from './mouse.js'

/** Shared handler for all five click variants. */
export async function handleClickVariant(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  button: 'left' | 'right' | 'middle',
  count: 1 | 2 | 3,
): Promise<CuCallToolResult> {
  // A prior left_mouse_down may have set mouseButtonHeld without a matching
  // left_mouse_up (e.g. drag rejected by a tier gate, model falls back to
  // left_click). executor.click() does its own mouseDown+mouseUp, releasing
  // the OS button — but without this, the JS flag stays true and all
  // subsequent mouse_move calls take the held-button path ("mouse"/
  // "mouse_full" actionKind + hit-test), causing spurious rejections on
  // click-tier and read-tier windows. Release first so click() gets a clean
  // slate.
  await releaseHeldMouse(adapter)

  const coord = extractCoordinate(args)
  if (coord instanceof Error) return errorResult(coord.message, 'bad_args')
  const [rawX, rawY] = coord

  // left_click(coordinate=[x,y], text="shift") — hold modifiers
  // during the click. Same chord parsing as the key tool.
  let modifiers: string[] | undefined
  if (args.text !== undefined) {
    if (typeof args.text !== 'string') {
      return errorResult('text must be a string', 'bad_args')
    }
    // Same gate as handleKey/handleHoldKey. withModifiers presses each name
    // via native.key(m, "press") — a non-modifier like "q" in text="cmd+q"
    // gets pressed while Cmd is held → Cmd+Q fires before the click.
    if (
      isSystemKeyCombo(args.text, adapter.executor.capabilities.platform) &&
      !overrides.grantFlags.systemKeyCombos
    ) {
      return errorResult(
        `The modifier chord "${args.text}" would fire a system shortcut. ` +
          'Request the systemKeyCombos grant flag via request_access, or use ' +
          'only modifier keys (shift, ctrl, alt, cmd) in the text parameter.',
        'grant_flag_required',
      )
    }
    modifiers = parseKeyChord(args.text)
  }

  // Right/middle-click and any click with a modifier chord escalate to
  // keyboard-equivalent input at tier "click" (context-menu Paste, chord
  // keystrokes). Compute once, pass to both gates.
  const clickActionKind: CuActionKind =
    button !== 'left' || (modifiers !== undefined && modifiers.length > 0)
      ? 'mouse_full'
      : 'mouse'

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    clickActionKind,
  )
  if (gate) return gate

  const display = await adapter.executor.getDisplaySize(
    overrides.selectedDisplayId,
  )

  // §6 item P — pixel-validation staleness check. Sub-gated.
  // Runs AFTER the gates (no point validating if we're about to refuse
  // anyway) but BEFORE the executor call.
  if (subGates.pixelValidation) {
    const { xPct, yPct } = coordToPercentageForPixelCompare(
      rawX,
      rawY,
      overrides.coordinateMode,
      overrides.lastScreenshot,
    )
    const validation = await validateClickTarget(
      adapter.cropRawPatch,
      overrides.lastScreenshot,
      xPct,
      yPct,
      async () => {
        // The fresh screenshot for validation uses the SAME allow-set as
        // the model's last screenshot did, so we compare like with like.
        const allowedIds = overrides.allowedApps.map(g => g.bundleId)
        try {
          // Fresh shot must match lastScreenshot's display, not the current
          // selection — pixel-compare is against the model's last image.
          return await adapter.executor.screenshot({
            allowedBundleIds: allowedIds,
            displayId: overrides.lastScreenshot?.displayId,
          })
        } catch {
          return null
        }
      },
      adapter.logger,
    )
    if (!validation.valid && validation.warning) {
      // Warning result — model told to re-screenshot.
      return okText(validation.warning)
    }
  }

  const { x, y } = scaleCoord(
    rawX,
    rawY,
    overrides.coordinateMode,
    display,
    overrides.lastScreenshot,
    adapter.logger,
  )

  const hitGate = await runHitTestGate(
    adapter,
    overrides,
    subGates,
    x,
    y,
    clickActionKind,
  )
  if (hitGate) return hitGate

  await adapter.executor.click(x, y, button, count, modifiers)
  return okText('Clicked.')
}
