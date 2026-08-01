import type {
  ComputerExecutor,
  DisplayGeometry,
  ScreenshotResult,
} from '../executor.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { errorResult } from './core.js'
import type { CuCallToolResult } from './core.js'

/** Detect actual image MIME type from base64 data by decoding the magic bytes. */
export function detectMimeFromBase64(b64: string): string {
  // Decode first 12 raw bytes (16 base64 chars is enough) and check standard magic bytes.
  // PNG:  89 50 4E 47
  // JPEG: FF D8 FF
  // RIFF+WEBP: "RIFF" at 0..3 + "WEBP" at 8..11
  // GIF:  "GIF" at 0..2
  const raw = Buffer.from(b64.slice(0, 16), 'base64')
  if (raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47)
    return 'image/png'
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg'
  if (
    raw[0] === 0x52 &&
    raw[1] === 0x49 &&
    raw[2] === 0x46 &&
    raw[3] === 0x46 && // RIFF
    raw[8] === 0x57 &&
    raw[9] === 0x45 &&
    raw[10] === 0x42 &&
    raw[11] === 0x50 // WEBP
  )
    return 'image/webp'
  if (raw[0] === 0x47 && raw[1] === 0x49 && raw[2] === 0x46) return 'image/gif'
  return 'image/png'
}

// ---------------------------------------------------------------------------
// Screenshot helpers
// ---------------------------------------------------------------------------

/**
 * §6 item 9 — screenshot retry on implausibly-small buffer. Battle-tested
 * threshold (1024 bytes). We retry exactly once.
 */
export const MIN_SCREENSHOT_BYTES = 1024

export function decodedByteLength(base64: string): number {
  // 3 bytes per 4 chars, minus padding. Good enough for a threshold check.
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor((base64.length * 3) / 4) - padding
}

export async function takeScreenshotWithRetry(
  executor: ComputerExecutor,
  allowedBundleIds: string[],
  logger: ComputerUseHostAdapter['logger'],
  displayId?: number,
): Promise<ScreenshotResult> {
  let shot = await executor.screenshot({ allowedBundleIds, displayId })
  if (decodedByteLength(shot.base64) < MIN_SCREENSHOT_BYTES) {
    logger.warn(
      `[computer-use] screenshot implausibly small (${decodedByteLength(shot.base64)} bytes decoded), retrying once`,
    )
    shot = await executor.screenshot({ allowedBundleIds, displayId })
  }
  return shot
}

/**
 * Build the hidden-apps note that accompanies a screenshot. Tells the model
 * which apps got hidden (not in allowlist) and how to add them. Returns
 * undefined when nothing was hidden since the last screenshot.
 */
export async function buildHiddenNote(
  adapter: ComputerUseHostAdapter,
  hiddenSinceLastSeen: string[],
): Promise<string | undefined> {
  if (hiddenSinceLastSeen.length === 0) return undefined
  const running = await adapter.executor.listRunningApps()
  const nameOf = new Map(running.map(a => [a.bundleId, a.displayName]))
  const names = hiddenSinceLastSeen.map(id => nameOf.get(id) ?? id)
  const list = names.map(n => `"${n}"`).join(', ')
  const one = names.length === 1
  return (
    `${list} ${one ? 'was' : 'were'} open and got hidden before this screenshot ` +
    `(not in the session allowlist). If a previous action was meant to open ` +
    `${one ? 'it' : 'one of them'}, that's why you don't see it — call ` +
    `request_access to add ${one ? 'it' : 'them'} to the allowlist.`
  )
}

/**
 * Assign a human-readable label to each display. Falls back to `display N`
 * when NSScreen.localizedName is undefined; disambiguates identical labels
 * (matched-pair external monitors) with a `(2)` suffix. Used by both
 * buildMonitorNote and handleSwitchDisplay so the name the model sees in a
 * screenshot note is the same name it can pass back to switch_display.
 */
export function uniqueDisplayLabels(
  displays: readonly DisplayGeometry[],
): Map<number, string> {
  // Sort by displayId so the (N) suffix is stable regardless of
  // NSScreen.screens iteration order — same label always maps to same
  // physical display across buildMonitorNote → switch_display round-trip,
  // even if display configuration reorders between the two calls.
  const sorted = [...displays].sort((a, b) => a.displayId - b.displayId)
  const counts = new Map<string, number>()
  const out = new Map<number, string>()
  for (const d of sorted) {
    const base = d.label ?? `display ${d.displayId}`
    const n = (counts.get(base) ?? 0) + 1
    counts.set(base, n)
    out.set(d.displayId, n === 1 ? base : `${base} (${n})`)
  }
  return out
}

/**
 * Build the monitor-context text that accompanies a screenshot. Tells the
 * model which monitor it's looking at (by human name), lists other attached
 * monitors, and flags when the monitor changed vs. the previous screenshot.
 *
 * Only emitted when there are 2+ displays AND (first screenshot OR the
 * display changed). Single-monitor setups and steady-state same-monitor
 * screenshots get no text — avoids noise.
 */
export async function buildMonitorNote(
  adapter: ComputerUseHostAdapter,
  shotDisplayId: number,
  lastDisplayId: number | undefined,
  canSwitchDisplay: boolean,
): Promise<string | undefined> {
  // listDisplays failure (e.g. Swift returns zero screens during monitor
  // hot-unplug) must not tank the screenshot — this note is optional context.
  let displays
  try {
    displays = await adapter.executor.listDisplays()
  } catch (e) {
    adapter.logger.warn(`[computer-use] listDisplays failed: ${String(e)}`)
    return undefined
  }
  if (displays.length < 2) return undefined

  const labels = uniqueDisplayLabels(displays)
  const nameOf = (id: number): string => labels.get(id) ?? `display ${id}`

  const current = nameOf(shotDisplayId)
  const others = displays
    .filter(d => d.displayId !== shotDisplayId)
    .map(d => nameOf(d.displayId))
  const switchHint = canSwitchDisplay
    ? ' Use switch_display to capture a different monitor.'
    : ''
  const othersList =
    others.length > 0
      ? ` Other attached monitors: ${others.map(n => `"${n}"`).join(', ')}.` +
        switchHint
      : ''

  // 0 is kCGNullDirectDisplay (sentinel from old sessions persisted
  // pre-multimon) — treat same as undefined.
  if (lastDisplayId === undefined || lastDisplayId === 0) {
    return `This screenshot was taken on monitor "${current}".` + othersList
  }
  if (lastDisplayId !== shotDisplayId) {
    const prev = nameOf(lastDisplayId)
    return (
      `This screenshot was taken on monitor "${current}", which is different ` +
      `from your previous screenshot (taken on "${prev}").` +
      othersList
    )
  }
  return undefined
}

export async function handleScreenshot(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  // §2 — empty allowlist → tool error, no screenshot.
  if (overrides.allowedApps.length === 0) {
    return errorResult(
      'No applications are granted for this session. Call request_access first.',
      'allowlist_empty',
    )
  }

  // Atomic resolve→prepare→capture (one Swift call, no scheduler gap).
  // Off → fall through to separate-calls path below.
  if (subGates.autoTargetDisplay) {
    // Model's explicit switch_display pin overrides everything — Swift's
    // straight cuDisplayInfo(forDisplayID:) passthrough, no chase chain.
    // Otherwise sticky display: only auto-resolve when the allowed-app
    // set has changed since the display was last resolved. Prevents the
    // resolver yanking the display on every screenshot.
    const allowedBundleIds = overrides.allowedApps.map(a => a.bundleId)
    const currentAppSetKey = allowedBundleIds.slice().sort().join(',')
    const appSetChanged = currentAppSetKey !== overrides.displayResolvedForApps
    const autoResolve = !overrides.displayPinnedByModel && appSetChanged

    const result = await adapter.executor.resolvePrepareCapture({
      allowedBundleIds,
      preferredDisplayId: overrides.selectedDisplayId,
      autoResolve,
      // Keep the hideBeforeAction sub-gate independently rollable —
      // atomic path honors the same toggle the non-atomic path checks
      // at the prepareForAction call site.
      doHide: subGates.hideBeforeAction,
    })

    // Non-atomic path's takeScreenshotWithRetry has a MIN_SCREENSHOT_BYTES
    // check + retry. The atomic call is expensive (resolve+prepare+capture),
    // so no retry here — just a warning when the result is implausibly
    // small (transient display state like sleep wake). Skip when
    // captureError is set (base64 is intentionally empty then).
    if (
      result.captureError === undefined &&
      decodedByteLength(result.base64) < MIN_SCREENSHOT_BYTES
    ) {
      adapter.logger.warn(
        `[computer-use] resolvePrepareCapture result implausibly small (${decodedByteLength(result.base64)} bytes decoded) — possible transient display state`,
      )
    }

    // Resolver picked a different display than the session had selected
    // (host window moved, or allowed app on a different display). Write
    // the pick back to session so teach overlay positioning and subsequent
    // non-resolver calls track the same display. Fire-and-forget.
    if (result.displayId !== overrides.selectedDisplayId) {
      adapter.logger.debug(
        `[computer-use] resolver: preferred=${overrides.selectedDisplayId} resolved=${result.displayId}`,
      )
      overrides.onResolvedDisplayUpdated?.(result.displayId)
    }
    // Record the app set this display was resolved for, so the next
    // screenshot skips auto-resolve until the set changes again. Gated on
    // autoResolve (not just appSetChanged) — when pinned, we didn't
    // actually resolve, so don't update the key.
    if (autoResolve) {
      overrides.onDisplayResolvedForApps?.(currentAppSetKey)
    }

    // Report hidden apps only when the model has already seen the screen.
    let hiddenSinceLastSeen: string[] = []
    if (overrides.lastScreenshot !== undefined) {
      hiddenSinceLastSeen = result.hidden
    }
    if (result.hidden.length > 0) {
      overrides.onAppsHidden?.(result.hidden)
    }

    // Partial-success case: hide succeeded, capture failed (SCK perm
    // revoked mid-session). onAppsHidden fired above so auto-unhide will
    // restore hidden apps at turn end. Now surface the error to the model.
    if (result.captureError !== undefined) {
      return errorResult(result.captureError, 'capture_failed')
    }

    const hiddenNote = await buildHiddenNote(adapter, hiddenSinceLastSeen)

    // Cherry-pick — don't spread `result` (would leak resolver fields into lastScreenshot).
    const shot: ScreenshotResult = {
      base64: result.base64,
      width: result.width,
      height: result.height,
      displayWidth: result.displayWidth,
      displayHeight: result.displayHeight,
      displayId: result.displayId,
      originX: result.originX,
      originY: result.originY,
    }

    const monitorNote = await buildMonitorNote(
      adapter,
      shot.displayId ?? 0,
      overrides.lastScreenshot?.displayId,
      overrides.onDisplayPinned !== undefined,
    )

    return {
      content: [
        ...(monitorNote ? [{ type: 'text' as const, text: monitorNote }] : []),
        ...(hiddenNote ? [{ type: 'text' as const, text: hiddenNote }] : []),
        // Accessibility snapshot: structured GUI element tree (Windows bound-window mode)
        ...(shot.accessibilityText
          ? [
              {
                type: 'text' as const,
                text: `GUI elements in this window:\n${shot.accessibilityText}`,
              },
            ]
          : []),
        {
          type: 'image',
          data: shot.base64,
          mimeType: detectMimeFromBase64(shot.base64),
        },
      ],
      screenshot: shot,
    }
  }

  // Same hide+defocus sequence as input actions. Screenshot needs hide too
  // — if a non-allowlisted app is on top, SCContentFilter would composite it
  // out, but the pixels BELOW it are what the model would see, and those are
  // NOT what's actually there. Hiding first makes the screenshot TRUE.
  let hiddenSinceLastSeen: string[] = []
  if (subGates.hideBeforeAction) {
    const hidden = await adapter.executor.prepareForAction(
      overrides.allowedApps.map(a => a.bundleId),
      overrides.selectedDisplayId,
    )
    // "Something appeared since the model last looked." Report whenever:
    //   (a) prepare hid something AND
    //   (b) the model has ALREADY SEEN the screen (lastScreenshot is set).
    //
    // (b) is the discriminator that silences the first screenshot's
    // expected-noise hide. NOT a delta against a cumulative set — that was
    // the earlier bug: cuHiddenDuringTurn only grows, so once Preview is in
    // it (from the first screenshot's hide), subsequent re-hides of Preview
    // delta to zero. The double-click → Preview opens → re-hide → silent
    // loop never breaks.
    //
    // With this check: every re-hide fires. If the model loops "click → file
    // opens in Preview → screenshot → Preview hidden", it gets told EVERY
    // time. Eventually it'll request_access for Preview (or give up).
    //
    // False positive: user alt-tabs mid-turn → Safari re-hidden → reported.
    // Rare, and "Safari appeared" is at worst mild noise — far better than
    // the false-negative of never explaining why the file vanished.
    if (overrides.lastScreenshot !== undefined) {
      hiddenSinceLastSeen = hidden
    }
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden)
    }
  }

  const allowedBundleIds = overrides.allowedApps.map(g => g.bundleId)
  const shot = await takeScreenshotWithRetry(
    adapter.executor,
    allowedBundleIds,
    adapter.logger,
    overrides.selectedDisplayId,
  )

  const hiddenNote = await buildHiddenNote(adapter, hiddenSinceLastSeen)

  const monitorNote = await buildMonitorNote(
    adapter,
    shot.displayId ?? 0,
    overrides.lastScreenshot?.displayId,
    overrides.onDisplayPinned !== undefined,
  )

  return {
    content: [
      ...(monitorNote ? [{ type: 'text' as const, text: monitorNote }] : []),
      ...(hiddenNote ? [{ type: 'text' as const, text: hiddenNote }] : []),
      // Accessibility snapshot: structured GUI element tree (Windows bound-window mode)
      ...(shot.accessibilityText
        ? [
            {
              type: 'text' as const,
              text: `GUI elements in this window:\n${shot.accessibilityText}`,
            },
          ]
        : []),
      {
        type: 'image',
        data: shot.base64,
        mimeType: detectMimeFromBase64(shot.base64),
      },
    ],
    // Piggybacked for serverDef.ts to stash on InternalServerContext.
    screenshot: shot,
  }
}
