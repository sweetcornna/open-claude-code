import { getDeniedCategoryForApp } from '../deniedApps.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuAppPermTier,
  CuSubGates,
} from '../types.js'
import { errorResult } from './core.js'
import type { CuCallToolResult } from './core.js'

/**
 * Finder is never hidden by the hide loop (hiding Finder kills the Desktop),
 * so it's always a valid frontmost.
 */
export const FINDER_BUNDLE_ID = 'com.apple.finder'

// ---------------------------------------------------------------------------
// Shared input-action gates
// ---------------------------------------------------------------------------

/**
 * Tier needed to perform a given action class. `undefined` → `"full"`.
 *
 *   - `"mouse_position"` — mouse_move only. Passes at any tier including
 *     `"read"`. Pure cursor positioning, no app interaction. Still runs
 *     prepareForAction (hide non-allowed apps).
 *   - `"mouse"` — plain left click, double/triple, scroll, drag-from.
 *     Requires tier `"click"` or `"full"`.
 *   - `"mouse_full"` — right/middle click, any click with modifiers,
 *     drag-drop (the `to` endpoint of left_click_drag). Requires tier
 *     `"full"`. Right-click → context menu Paste, modifier chords →
 *     keystrokes before click, drag-drop → text insertion at the drop
 *     point. All escalate a click-tier grant to keyboard-equivalent input.
 *     Blunt: also rejects same-app drags (scrollbar, panel resize) onto
 *     click-tier apps; `scroll` is the tier-"click" way to scroll.
 *   - `"keyboard"` — type, key, hold_key. Requires tier `"full"`.
 */
export type CuActionKind =
  | 'mouse_position'
  | 'mouse'
  | 'mouse_full'
  | 'keyboard'

export function tierSatisfies(
  grantTier: CuAppPermTier | undefined,
  actionKind: CuActionKind,
): boolean {
  const tier = grantTier ?? 'full'
  if (actionKind === 'mouse_position') return true
  if (actionKind === 'keyboard' || actionKind === 'mouse_full') {
    return tier === 'full'
  }
  // mouse
  return tier === 'click' || tier === 'full'
}

// Appended to every tier_insufficient error. The model may try to route
// around the gate (osascript, System Events, cliclick via Bash) — this
// closes that door explicitly. Leading space so it concatenates cleanly.
export const TIER_ANTI_SUBVERSION =
  ' Do not attempt to work around this restriction — never use AppleScript, ' +
  'System Events, shell commands, or any other method to send clicks or ' +
  'keystrokes to this app.'

// ---------------------------------------------------------------------------
// Clipboard guard — stash+clear while a click-tier app is frontmost
// ---------------------------------------------------------------------------
//
// Threat: tier "click" blocks type/key/right-click-Paste, but a click-tier
// terminal/IDE may have a UI Paste button that's plain-left-clickable. If the
// clipboard holds `rm -rf /` — from the user, from a prior full-tier paste,
// OR from the agent's own write_clipboard call (which doesn't route through
// runInputActionGates) — a left_click on that button injects it.
//
// Mitigation: stash the user's clipboard on first entry to click-tier, then
// RE-CLEAR before every input action while click-tier stays frontmost. The
// re-clear is the load-bearing part — a stash-on-transition-only design
// leaves a gap between an agent write_clipboard and the next left_click.
// When frontmost becomes anything else, restore. Turn-end restore is inlined
// in the host's result-handler + leavingRunning (same dual-location as
// cuHiddenDuringTurn unhide) — reads `session.cuClipboardStash` directly and
// writes via Electron's `clipboard.writeText`, so no nest-only import.
//
// State lives on the session (via `overrides.getClipboardStash` /
// `onClipboardStashChanged`), not module-level. The CU lock still guarantees
// one session at a time, but session-scoped state means the host's turn-end
// restore doesn't need to reach back into this package.

export async function syncClipboardStash(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  frontmostIsClickTier: boolean,
): Promise<void> {
  const current = overrides.getClipboardStash?.()
  if (!frontmostIsClickTier) {
    // Restore + clear. Idempotent — if nothing is stashed, no-op.
    if (current === undefined) return
    try {
      await adapter.executor.writeClipboard(current)
      // Clear only after a successful write — a transient pasteboard
      // failure must not irrecoverably drop the stash.
      overrides.onClipboardStashChanged?.(undefined)
    } catch {
      // Best effort — stash held, next non-click action retries.
    }
    return
  }
  // Stash the user's clipboard on FIRST entry to click-tier only.
  if (current === undefined) {
    try {
      const read = await adapter.executor.readClipboard()
      overrides.onClipboardStashChanged?.(read)
    } catch {
      // readClipboard failed — use empty sentinel so we don't retry the stash
      // on the next action; restore becomes a harmless writeClipboard("").
      overrides.onClipboardStashChanged?.('')
    }
  }
  // Re-clear on EVERY click-tier action, not just the first. Defeats the
  // bypass where the agent calls write_clipboard (which doesn't route
  // through runInputActionGates) between stash and a left_click on a UI
  // Paste button — the next action's clear clobbers the agent's write
  // before the click lands.
  try {
    await adapter.executor.writeClipboard('')
  } catch {
    // Transient pasteboard failure. The tier-"click" right-click/modifier
    // block still holds; this is a net, not a promise.
  }
}

/** Every click/type/key/scroll/drag/move_mouse runs through this before
 * touching the executor. Returns null on pass, error-result on block.
 * Any throw inside → caught by handleToolCall's outer try → tool error. */
export async function runInputActionGates(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  actionKind: CuActionKind,
): Promise<CuCallToolResult | null> {
  // Step A+B — hide non-allowlisted apps + defocus us. Sub-gated. After this
  // runs, the frontmost gate below becomes a rare edge-case detector (something
  // popped up between prepare and action) rather than a normal-path blocker.
  // ALL grant tiers stay visible — visibility is the baseline (tier "read").
  if (subGates.hideBeforeAction) {
    const hidden = await adapter.executor.prepareForAction(
      overrides.allowedApps.map(a => a.bundleId),
      overrides.selectedDisplayId,
    )
    // Empty-check so we don't spam the callback on every action when nothing
    // was hidden (the common case after the first action of a turn).
    if (hidden.length > 0) {
      overrides.onAppsHidden?.(hidden)
    }
  }

  // Windows/Linux: operations go through SendMessage (HWND-bound) or platform
  // abstraction, not global input to the foreground. The frontmost gate is a
  // macOS safety net for global CGEvent input — on other platforms, skip it
  // when the platform's screenshotFiltering is 'none' (no per-app filtering,
  // meaning no hide/defocus, meaning frontmost is meaningless).
  if (adapter.executor.capabilities.screenshotFiltering === 'none') {
    return null // pass — non-macOS platform, frontmost irrelevant
  }

  // Frontmost gate. Check FRESH on every call.
  const frontmost = await adapter.executor.getFrontmostApp()

  const tierByBundleId = new Map(
    overrides.allowedApps.map(a => [a.bundleId, a.tier] as const),
  )

  // After handleToolCall's tier backfill, every grant has a concrete tier —
  // .get() returning undefined means the app is not in the allowlist at all.
  const frontmostTier = frontmost
    ? tierByBundleId.get(frontmost.bundleId)
    : undefined

  // Clipboard guard. Per-action, not per-tool-call — runs for every sub-action
  // inside computer_batch and teach_step/teach_batch, so clicking into a
  // click-tier app mid-batch stashes+clears before the next click lands.
  // Lives here (not in handleToolCall) so deferAcquire tools (request_access,
  // list_granted_applications), `wait`, and the teach_step blocking-dialog
  // phase don't trigger a sync — only input actions do.
  if (subGates.clipboardGuard) {
    await syncClipboardStash(adapter, overrides, frontmostTier === 'click')
  }

  if (!frontmost) {
    // No frontmost app (rare — login window?). Let it through; the click
    // will land somewhere and PixelCompare catches staleness.
    return null
  }

  const { hostBundleId } = adapter.executor.capabilities

  if (frontmostTier !== undefined) {
    if (tierSatisfies(frontmostTier, actionKind)) return null
    // In the allowlist but tier doesn't cover this action. Tailor the
    // guidance to the actual tier — at "read", suggesting left_click or Bash
    // is wrong (nothing is allowed). At "click", the
    // mouse_full/keyboard-specific messages apply.
    if (frontmostTier === 'read') {
      // tier "read" is not category-unique (browser AND trading map to it) —
      // re-look-up so the browser-MCP hint only shows for actual browsers.
      const isBrowser =
        getDeniedCategoryForApp(frontmost.bundleId, frontmost.displayName) ===
        'browser'
      return errorResult(
        `"${frontmost.displayName}" is granted at tier "read" — ` +
          `visible in screenshots only, no clicks or typing.` +
          (isBrowser
            ? ' Use a separately configured browser automation tool if one ' +
              'is available; otherwise ask the user to perform the interaction.'
            : ' No interaction is permitted; ask the user to take any ' +
              'actions in this app themselves.') +
          TIER_ANTI_SUBVERSION,
        'tier_insufficient',
      )
    }
    // frontmostTier === "click" (tier === "full" would have passed tierSatisfies)
    if (actionKind === 'keyboard') {
      return errorResult(
        `"${frontmost.displayName}" is granted at tier "click" — ` +
          `typing, key presses, and paste require tier "full". The keys ` +
          `would go to this app's text fields or integrated terminal. To ` +
          `type into a different app, click it first to bring it forward. ` +
          `For shell commands, use the Bash tool.` +
          TIER_ANTI_SUBVERSION,
        'tier_insufficient',
      )
    }
    // actionKind === "mouse_full" ("mouse" and "mouse_position" pass at "click")
    return errorResult(
      `"${frontmost.displayName}" is granted at tier "click" — ` +
        `right-click, middle-click, and clicks with modifier keys require ` +
        `tier "full". Right-click opens a context menu with Paste/Cut, and ` +
        `modifier chords fire as keystrokes before the click. Plain ` +
        `left_click is allowed here.` +
        TIER_ANTI_SUBVERSION,
      'tier_insufficient',
    )
  }
  // Finder is never-hide, always allowed.
  if (frontmost.bundleId === FINDER_BUNDLE_ID) return null

  if (frontmost.bundleId === hostBundleId) {
    if (actionKind !== 'keyboard') {
      // mouse and mouse_full are both click events — click-through works.
      // We're click-through (executor's withClickThrough). Pass.
      return null
    }
    // Keyboard safety net — defocus (prepareForAction step B) should have
    // moved us off. If we're still here, typing would go to our chat box.
    return errorResult(
      "Claude's own window still has keyboard focus. This should not happen " +
        'after the pre-action defocus. Click on the target application first.',
      'state_conflict',
    )
  }

  // Non-allowlisted, non-us, non-Finder. RARE after the hide loop — means
  // something popped up between prepare and action, or the 5-try loop gave up.
  return errorResult(
    `"${frontmost.displayName}" is not in the allowed applications and is ` +
      `currently in front. Take a new screenshot — it may have appeared ` +
      `since your last one.`,
    'app_not_granted',
  )
}

/**
 * Hit-test gate: reject a mouse action if the window under (x, y) belongs
 * to an app whose tier doesn't cover mouse input. Closes the gap where a
 * tier-"full" app is frontmost but the click lands on a tier-"read" window
 * overlapping it — `runInputActionGates` passes (frontmost is fine), but the
 * click actually goes to the read-tier app.
 *
 * Runs AFTER `scaleCoord` (needs global coords) and BEFORE the executor call.
 * Returns null on pass (target is tier-"click"/"full", or desktop/Finder/us),
 * error-result on block.
 *
 * When `appUnderPoint` returns null (desktop, or platform without hit-test),
 * falls through — the frontmost check in `runInputActionGates` already ran.
 */
export async function runHitTestGate(
  adapter: ComputerUseHostAdapter,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
  x: number,
  y: number,
  actionKind: CuActionKind,
): Promise<CuCallToolResult | null> {
  // Non-macOS: HWND-bound mode — clicks go to the bound window via
  // SendMessage with window-relative coordinates. Hit-test against the
  // real screen is meaningless.
  if (adapter.executor.capabilities.screenshotFiltering === 'none') {
    return null
  }

  const target = await adapter.executor.appUnderPoint(x, y)
  if (!target) return null // desktop / nothing under point / platform no-op

  // Finder (desktop, file dialogs) is always clickable — same exemption as
  // runInputActionGates. Our own overlay is filtered by Swift (pid != self).
  if (target.bundleId === FINDER_BUNDLE_ID) return null

  const tierByBundleId = new Map(
    overrides.allowedApps.map(a => [a.bundleId, a.tier] as const),
  )

  if (!tierByBundleId.has(target.bundleId)) {
    // Not in the allowlist at all. The frontmost check would catch this if
    // the target were frontmost, but here a different app is in front. This
    // is the "something popped up" edge case — a new window appeared between
    // screenshot and click, or a background app's window overlaps the target.
    return errorResult(
      `Click at these coordinates would land on "${target.displayName}", ` +
        `which is not in the allowed applications. Take a fresh screenshot ` +
        `to see the current window layout.`,
      'app_not_granted',
    )
  }

  const targetTier = tierByBundleId.get(target.bundleId)

  // Frontmost-based sync (runInputActionGates) misses the case where
  // the click lands on a NON-FRONTMOST click-tier window. Re-sync by
  // the hit-test target's tier — if target is click-tier, stash+clear
  // before the click lands, regardless of what's frontmost.
  if (subGates.clipboardGuard && targetTier === 'click') {
    await syncClipboardStash(adapter, overrides, true)
  }

  if (tierSatisfies(targetTier, actionKind)) return null

  // Target is in the allowlist but tier doesn't cover this action.
  // runHitTestGate is only called with mouse/mouse_full (keyboard routes to
  // frontmost, not window-under-cursor). The branch above catches
  // mouse_full ∧ click; the only remaining fall-through is tier "read".
  if (actionKind === 'mouse_full' && targetTier === 'click') {
    return errorResult(
      `Click at these coordinates would land on "${target.displayName}", ` +
        `which is granted at tier "click" — right-click, middle-click, and ` +
        `clicks with modifier keys require tier "full" (they can Paste via ` +
        `the context menu or fire modifier-chord keystrokes). Plain ` +
        `left_click is allowed here.` +
        TIER_ANTI_SUBVERSION,
      'tier_insufficient',
    )
  }
  const isBrowser =
    getDeniedCategoryForApp(target.bundleId, target.displayName) === 'browser'
  return errorResult(
    `Click at these coordinates would land on "${target.displayName}", ` +
      `which is granted at tier "read" (screenshots only, no interaction). ` +
      (isBrowser
        ? 'Use a separately configured browser automation tool if one is ' +
          'available; otherwise ask the user to perform the interaction.'
        : 'Ask the user to take any actions in this app themselves.') +
      TIER_ANTI_SUBVERSION,
    'tier_insufficient',
  )
}
