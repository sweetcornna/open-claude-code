/**
 * Tool dispatch. Every security decision is enforced before an executor
 * method is called. Domain handlers live in ./toolCalls/.
 */

import { getDefaultTierForApp, isPolicyDenied } from './deniedApps.js'
import {
  handleRequestAccess,
  handleRequestTeachAccess,
} from './toolCalls/access.js'
import {
  buildTierGuidanceMessage,
  buildUserDeniedGuidance,
} from './toolCalls/accessGuidance.js'
import {
  buildAccessRequest,
  looksLikeBundleId,
  resolveRequestedApps,
} from './toolCalls/accessResolve.js'
import {
  coordToPercentageForPixelCompare,
  scaleCoord,
} from './toolCalls/coordinates.js'
import { asRecord, errorResult, extractCoordinate } from './toolCalls/core.js'
import type { CuCallToolResult } from './toolCalls/core.js'
import { dispatchAction } from './toolCalls/dispatch.js'
import { tierSatisfies } from './toolCalls/inputGates.js'
import { parseKeyChord, segmentGraphemes } from './toolCalls/keyboard.js'
import { resetMouseButtonHeld } from './toolCalls/mouse.js'
import {
  buildMonitorNote,
  decodedByteLength,
  uniqueDisplayLabels,
} from './toolCalls/screenshot.js'
import { handleTeachBatch, handleTeachStep } from './toolCalls/teach.js'
import { defersLockAcquire } from './toolCalls/timing.js'
import { handleSwitchDisplay } from './toolCalls/windows.js'
import { toLoggerDetail } from './types.js'
import type { ComputerUseHostAdapter, ComputerUseOverrides } from './types.js'

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

export async function handleToolCall(
  adapter: ComputerUseHostAdapter,
  name: string,
  args: unknown,
  rawOverrides: ComputerUseOverrides,
): Promise<CuCallToolResult> {
  const { logger, serverName } = adapter

  // Normalize the allowlist before any gate runs:
  //
  // (a) Strip user-denied. A grant from a previous session (before the user
  //     added the app to Settings → Desktop app → Computer Use → Denied apps)
  //     must not survive. Without
  //     this, a stale grant bypasses the auto-deny. Stripped silently — the
  //     agent already saw the userDenied guidance at request_access time, and
  //     a live frontmost-gate rejection cites "not in allowed applications".
  //
  // (b) Strip policy-denied. Same story as (a) for a grant that predates a
  //     blocklist addition. buildAccessRequest denies these up front for new
  //     requests; this catches stale persisted grants.
  //
  // (c) Backfill tier. A grant persisted before the tier field existed has
  //     `tier: undefined`, which `tierSatisfies` treats as `"full"` — wrong
  //     for a legacy Chrome grant. Assign the hardcoded tier based on
  //     bundle-ID category. Modern grants already have a tier.
  //
  // `.some()` guard keeps the hot path (empty deny list, no legacy grants)
  // zero-alloc.
  const userDeniedSet = new Set(rawOverrides.userDeniedBundleIds)
  const overrides: ComputerUseOverrides = rawOverrides.allowedApps.some(
    a =>
      a.tier === undefined ||
      userDeniedSet.has(a.bundleId) ||
      isPolicyDenied(a.bundleId, a.displayName),
  )
    ? {
        ...rawOverrides,
        allowedApps: rawOverrides.allowedApps
          .filter(a => !userDeniedSet.has(a.bundleId))
          .filter(a => !isPolicyDenied(a.bundleId, a.displayName))
          .map(a =>
            a.tier !== undefined
              ? a
              : { ...a, tier: getDefaultTierForApp(a.bundleId, a.displayName) },
          ),
      }
    : rawOverrides

  // ─── Gate 1: kill switch ─────────────────────────────────────────────
  if (adapter.isDisabled()) {
    return errorResult(
      'Computer control is disabled in Settings. Enable it and try again.',
      'other',
    )
  }

  // ─── Gate 2: TCC ─────────────────────────────────────────────────────
  // Accessibility + Screen Recording on macOS. Pure check — no dialog,
  // no relaunch. `request_access` is exempted: it threads the ungranted
  // state through to the renderer, which shows a TCC toggle panel instead
  // of the app list. Every other tool short-circuits here.
  const osPerms = await adapter.ensureOsPermissions()
  let tccState: { accessibility: boolean; screenRecording: boolean } | undefined
  if (!osPerms.granted) {
    // Both request_* tools thread tccState through to the renderer's
    // TCC toggle panel. Every other tool short-circuits.
    if (name !== 'request_access' && name !== 'request_teach_access') {
      return errorResult(
        'Accessibility and Screen Recording permissions are required. ' +
          'Call request_access to show the permission panel.',
        'tcc_not_granted',
      )
    }
    tccState = {
      accessibility: (
        osPerms as {
          granted: false
          accessibility: boolean
          screenRecording: boolean
        }
      ).accessibility,
      screenRecording: (
        osPerms as {
          granted: false
          accessibility: boolean
          screenRecording: boolean
        }
      ).screenRecording,
    }
  }

  // ─── Gate 3: global CU lock ──────────────────────────────────────────
  // At most one session uses CU at a time. Every tool including
  // request_access hits the CHECK — even showing the approval dialog while
  // another session holds the lock would be confusing ("why approve access
  // that can't be used?").
  //
  // But ACQUIRE is split: request_access and list_granted_applications
  // check-without-acquire (the overlay + notifications are driven by
  // cuLockChanged, and showing "Claude is using your computer" while the
  // agent is only ASKING for access is premature). First action tool
  // acquires and the overlay appears. If the user denies and no action
  // follows, the overlay never shows.
  //
  // request_teach_access is NOT in this set — approving teach mode HIDES
  // the main window (via onTeachModeActivated), and the lock must be held
  // before that happens. Otherwise a concurrent session's request_access
  // would render its dialog in an invisible main window during the gap
  // between hide and the first teach_step (seconds of model inference).
  // The old acquire-always-at-Gate-3 behavior was correct for teach; only
  // the non-teach permission tools benefit from deferral.
  //
  // Host releases on idle/stop/archive; this package never releases. Both
  // Cowork (LAM) and CCD (LSM) wire checkCuLock via the shared cuLock
  // singleton. When undefined (tests/future hosts), no gate — absence of
  // the mechanism ≠ locked out.
  const deferAcquire = defersLockAcquire(name)
  const lock = overrides.checkCuLock?.()
  if (lock) {
    if (lock.holder !== undefined && !lock.isSelf) {
      return errorResult(
        'Another Claude session is currently using the computer. Wait for ' +
          'the user to acknowledge it is finished (stop button in the Claude ' +
          'window), or find a non-computer-use approach if one is readily ' +
          'apparent.',
        'cu_lock_held',
      )
    }
    if (lock.holder === undefined && !deferAcquire) {
      // Acquire. Emits cuLockChanged → overlay shows. Idempotent — if
      // someone else acquired between check and here (won't happen on a
      // single-threaded event loop, but defensive), this is a no-op.
      overrides.acquireCuLock?.()
      // Fresh lock holder → any prior session's mouseButtonHeld is stale
      // (e.g. overlay stop mid-drag). Clear it so this session doesn't get
      // a spurious "already held" error. resetMouseButtonHeld is file-local;
      // this is the one non-test callsite.
      resetMouseButtonHeld()
    }
    // lock.isSelf → already held by us, proceed.
    // lock.holder === undefined && deferAcquire →
    //   checked but not acquired — proceed, first action will acquire.
  }

  // Sub-gates read FRESH every call so a GrowthBook flip takes effect
  // mid-session (plan §3).
  const subGates = adapter.getSubGates()

  // Clipboard guard runs per-action inside runInputActionGates + inline in
  // handleReadClipboard/handleWriteClipboard. NOT here — per-tool-call sync
  // would run once for computer_batch and miss sub-actions 2..N, and would
  // fire during deferAcquire tools / `wait` / teach_step's blocking-dialog
  // phase where no input is happening.

  const a = asRecord(args)

  logger.silly(
    `[${serverName}] tool=${name} args=${JSON.stringify(a).slice(0, 200)}`,
  )

  // ─── Fail-closed dispatch ────────────────────────────────────────────
  // ANY exception below → tool error, executor never left in a half-called
  // state. Explicit inversion of the prior `catch → return true` fail-open.
  try {
    // request_access / request_teach_access: need tccState thread-through;
    // dispatchAction never sees them (not batchable).
    // teach_step: blocking UI tool, also not batchable; needs subGates for
    // its action-execution phase.
    if (name === 'request_access') {
      return await handleRequestAccess(adapter, a, overrides, tccState)
    }
    if (name === 'request_teach_access') {
      return await handleRequestTeachAccess(adapter, a, overrides, tccState)
    }
    if (name === 'teach_step') {
      return await handleTeachStep(adapter, a, overrides, subGates)
    }
    if (name === 'teach_batch') {
      return await handleTeachBatch(adapter, a, overrides, subGates)
    }
    return await dispatchAction(name, a, adapter, overrides, subGates)
  } catch (err) {
    // Fail-closed. If the gate machinery itself throws (e.g.
    // getFrontmostApp() rejects), the executor has NOT been called yet for
    // the gated tools — the gates run before the executor in every handler.
    // For ungated tools, the executor may have been mid-call; that's fine —
    // the result is still a tool error, never an implicit success.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error(
      `[${serverName}] tool=${name} threw: ${msg}`,
      toLoggerDetail(err),
    )
    return errorResult(`Tool "${name}" failed: ${msg}`, 'executor_threw')
  }
}

export const _test = {
  scaleCoord,
  coordToPercentageForPixelCompare,
  segmentGraphemes,
  decodedByteLength,
  resolveRequestedApps,
  buildAccessRequest,
  buildTierGuidanceMessage,
  buildUserDeniedGuidance,
  tierSatisfies,
  looksLikeBundleId,
  extractCoordinate,
  parseKeyChord,
  buildMonitorNote,
  handleSwitchDisplay,
  uniqueDisplayLabels,
}

export { defersLockAcquire } from './toolCalls/timing.js'
export { resetMouseButtonHeld } from './toolCalls/mouse.js'
export type {
  CuCallTelemetry,
  CuCallToolResult,
  CuErrorKind,
} from './toolCalls/core.js'
