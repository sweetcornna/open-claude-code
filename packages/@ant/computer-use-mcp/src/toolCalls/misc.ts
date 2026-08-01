import type { ComputerUseHostAdapter, ComputerUseOverrides } from '../types.js'
import { errorResult, okJson, okText } from './core.js'
import type { CuCallToolResult } from './core.js'
import { detectMimeFromBase64 } from './screenshot.js'
import { sleep } from './timing.js'

/**
 * Region-crop upscaled screenshot. Coord invariant (computer_use_v2.py:1092):
 * click coords ALWAYS refer to the full-screen screenshot, never the zoom.
 * Enforced structurally: this handler's return has NO `.screenshot` field,
 * so serverDef.ts's `if (result.screenshot)` branch cannot fire and
 * `cuLastScreenshot` is never touched. `executor.zoom()`'s return type also
 * lacks displayWidth/displayHeight, so it's not assignable to
 * `ScreenshotResult` even by accident.
 */
export async function handleZoom(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  // region: [x0, y0, x1, y1] in IMAGE-PX of lastScreenshot — same space the
  // model reads click coords from.
  const region = args.region
  if (!Array.isArray(region) || region.length !== 4) {
    return errorResult(
      'region must be an array of length 4: [x0, y0, x1, y1]',
      'bad_args',
    )
  }
  const [x0, y0, x1, y1] = region
  if (![x0, y0, x1, y1].every(v => typeof v === 'number' && v >= 0)) {
    return errorResult('region values must be non-negative numbers', 'bad_args')
  }
  if (x1 <= x0)
    return errorResult('region x1 must be greater than x0', 'bad_args')
  if (y1 <= y0)
    return errorResult('region y1 must be greater than y0', 'bad_args')

  const last = overrides.lastScreenshot
  if (!last) {
    return errorResult(
      'take a screenshot before zooming (region coords are relative to it)',
      'state_conflict',
    )
  }
  if (x1 > last.width || y1 > last.height) {
    return errorResult(
      `region exceeds screenshot bounds (${last.width}×${last.height})`,
      'bad_args',
    )
  }

  // image-px → logical-pt. Same ratio as scaleCoord (:198-199) —
  // displayWidth / width, not 1/scaleFactor. The ratio is folded.
  const ratioX = last.displayWidth / last.width
  const ratioY = last.displayHeight / last.height
  const regionLogical = {
    x: x0 * ratioX,
    y: y0 * ratioY,
    w: (x1 - x0) * ratioX,
    h: (y1 - y0) * ratioY,
  }

  const allowedIds = overrides.allowedApps.map(g => g.bundleId)
  // Crop from the same display as lastScreenshot so the zoom region
  // matches the image the model is reading coords from.
  const zoomed = await adapter.executor.zoom(
    regionLogical,
    allowedIds,
    last.displayId,
  )

  // Return the image. NO `.screenshot` piggyback — this is the invariant.
  return {
    content: [
      {
        type: 'image',
        data: zoomed.base64,
        mimeType: detectMimeFromBase64(zoomed.base64),
      },
    ],
  }
}

/**
 * wait(duration=N). Sleeps N seconds, capped at 100.
 * No frontmost gate — no input, nothing to protect. Kill-switch + TCC
 * are checked in handleToolCall before dispatch reaches here.
 */
export async function handleWait(
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  const duration = args.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return errorResult('duration must be a number', 'bad_args')
  }
  if (duration < 0) {
    return errorResult('duration must be non-negative', 'bad_args')
  }
  if (duration > 100) {
    return errorResult(
      'duration is too long. Duration is in seconds.',
      'bad_args',
    )
  }
  await sleep(duration * 1000)
  return okText(`Waited ${duration}s.`)
}

/**
 * Returns "X=...,Y=..." plain text. We return richer JSON with
 * coordinateSpace annotation — the model handles both shapes.
 *
 * When lastScreenshot is present: inverse of scaleCoord — logical points →
 * image-pixels via `imageX = logicalX × (screenshotWidth / displayWidth)`.
 * Uses capture-time dims so the returned coords match what the model would
 * read off that screenshot.
 *
 * No frontmost gate — read-only, no input.
 */
export async function handleCursorPosition(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const logical = await adapter.executor.getCursorPosition()
  const shot = overrides.lastScreenshot
  if (shot) {
    // Inverse of scaleCoord: subtract capture-time origin to go from
    // virtual-screen to display-relative before the image-px transform.
    const localX = logical.x - shot.originX
    const localY = logical.y - shot.originY
    // Cursor off the captured display (multi-monitor): local coords go
    // negative or exceed display dims. Return logical_points + hint rather
    // than garbage image-px.
    if (
      localX < 0 ||
      localX > shot.displayWidth ||
      localY < 0 ||
      localY > shot.displayHeight
    ) {
      return okJson({
        x: logical.x,
        y: logical.y,
        coordinateSpace: 'logical_points',
        note: 'cursor is on a different monitor than your last screenshot; take a fresh screenshot',
      })
    }
    const x = Math.round(localX * (shot.width / shot.displayWidth))
    const y = Math.round(localY * (shot.height / shot.displayHeight))
    return okJson({ x, y, coordinateSpace: 'image_pixels' })
  }
  return okJson({
    x: logical.x,
    y: logical.y,
    coordinateSpace: 'logical_points',
    note: 'take a screenshot first for image-pixel coordinates',
  })
}
