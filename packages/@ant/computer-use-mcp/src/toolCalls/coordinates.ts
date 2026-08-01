import type { DisplayGeometry, ScreenshotResult } from '../executor.js'
import type { CoordinateMode, Logger } from '../types.js'

// ---------------------------------------------------------------------------
// Coordinate scaling
// ---------------------------------------------------------------------------

/**
 * Convert model-space coordinates to the logical points that enigo expects.
 *
 *   - `normalized_0_100`: (x / 100) * display.width. `display` is fetched
 *     fresh per tool call — never cached across calls —
 *     so a mid-session display-settings change doesn't leave us stale.
 *   - `pixels`: the model sent image-space pixel coords (it read them off the
 *     last screenshot). With the 1568-px long-edge downsample, the
 *     screenshot-px → logical-pt ratio is `displayWidth / screenshotWidth`,
 *     NOT `1/scaleFactor`. Uses the display geometry stashed at CAPTURE time
 *     (`lastScreenshot.displayWidth`), not fresh — so the transform matches
 *     what the model actually saw even if the user changed display settings
 *     since. (Chrome's ScreenshotContext pattern — CDPService.ts:1486-1493.)
 */
export function scaleCoord(
  rawX: number,
  rawY: number,
  mode: CoordinateMode,
  display: DisplayGeometry,
  lastScreenshot: ScreenshotResult | undefined,
  logger: Logger,
): { x: number; y: number } {
  if (mode === 'normalized_0_100') {
    // Origin offset targets the selected display in virtual-screen space.
    return {
      x: Math.round((rawX / 100) * display.width) + display.originX,
      y: Math.round((rawY / 100) * display.height) + display.originY,
    }
  }

  // mode === "pixels": model sent image-space pixel coords.
  if (lastScreenshot) {
    // The transform. Chrome coordinateScaling.ts:22-34 + claude-in-a-box
    // ComputerTool.swift:70-80 — two independent convergent impls.
    // Uses the display geometry stashed AT CAPTURE TIME, not fresh.
    // Origin from the same snapshot keeps clicks coherent with the captured display.
    return {
      x:
        Math.round(
          rawX * (lastScreenshot.displayWidth / lastScreenshot.width),
        ) + lastScreenshot.originX,
      y:
        Math.round(
          rawY * (lastScreenshot.displayHeight / lastScreenshot.height),
        ) + lastScreenshot.originY,
    }
  }

  // Cold start: model sent pixel coords without having taken a screenshot.
  // Degenerate — fall back to the old /sf behavior and warn.
  logger.warn(
    '[computer-use] pixels-mode coordinate received with no prior screenshot; ' +
      'falling back to /scaleFactor. Click may be off if downsample is active.',
  )
  return {
    x: Math.round(rawX / display.scaleFactor) + display.originX,
    y: Math.round(rawY / display.scaleFactor) + display.originY,
  }
}

/**
 * Convert model-space coordinates to the 0–100 percentage that
 * pixelCompare.ts works in. The staleness check operates in screenshot-image
 * space; comparing by percentage lets us crop both last and fresh screenshots
 * at the same relative location without caring about their absolute dims.
 *
 * With the 1568-px downsample, `screenshot.width != display.width * sf`, so
 * the old `rawX / (display.width * sf)` formula is wrong. The correct
 * denominator is just `lastScreenshot.width` — the model's raw pixel coord is
 * already in that image's coordinate space. `DisplayGeometry` is no longer
 * consumed at all.
 */
export function coordToPercentageForPixelCompare(
  rawX: number,
  rawY: number,
  mode: CoordinateMode,
  lastScreenshot: ScreenshotResult | undefined,
): { xPct: number; yPct: number } {
  if (mode === 'normalized_0_100') {
    // Unchanged — already a percentage.
    return { xPct: rawX, yPct: rawY }
  }

  // mode === "pixels"
  if (!lastScreenshot) {
    // validateClickTarget at pixelCompare.ts:141-143 already skips when
    // lastScreenshot is undefined, so this return value never reaches a crop.
    return { xPct: 0, yPct: 0 }
  }
  return {
    xPct: (rawX / lastScreenshot.width) * 100,
    yPct: (rawY / lastScreenshot.height) * 100,
  }
}
