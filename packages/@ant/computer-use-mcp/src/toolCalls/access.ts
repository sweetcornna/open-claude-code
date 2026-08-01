import type {
  AppGrant,
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuGrantFlags,
  CuPermissionRequest,
  CuTeachPermissionRequest,
} from '../types.js'
import {
  buildPolicyDeniedGuidance,
  buildTierGuidanceMessage,
  buildUserDeniedGuidance,
  tierAssignmentTelemetry,
} from './accessGuidance.js'
import { buildAccessRequest, buildWindowLocations } from './accessResolve.js'
import { errorResult, okJson, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'
import { randomUUID } from 'node:crypto'

// ---------------------------------------------------------------------------
// Individual tool handlers
// ---------------------------------------------------------------------------

export async function handleRequestAccess(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  tccState: { accessibility: boolean; screenRecording: boolean } | undefined,
): Promise<CuCallToolResult> {
  if (!overrides.onPermissionRequest) {
    return errorResult(
      'This session was not wired with a permission handler. Computer control is not available here.',
      'feature_unavailable',
    )
  }

  // Teach mode hides the main window; permission dialogs render in that
  // window. Without this, handleToolPermission blocks on an invisible
  // prompt and the overlay spins forever. Tell the model to exit teach
  // mode, request access, then re-enter.
  if (overrides.getTeachModeActive?.()) {
    return errorResult(
      'Cannot request additional permissions during teach mode — the permission dialog would be hidden. End teach mode (finish the tour or let the turn complete), then call request_access, then start a new tour.',
      'teach_mode_conflict',
    )
  }

  const reason = requireString(args, 'reason')
  if (reason instanceof Error) return errorResult(reason.message, 'bad_args')

  // TCC-ungranted branch. The renderer shows a toggle panel INSTEAD OF the
  // app list when `tccState` is present on the request, so we skip app
  // resolution entirely (listInstalledApps() may fail without Screen
  // Recording anyway). The user grants the OS perms from inside the dialog,
  // then clicks "Ask again" — both buttons resolve with deny by design
  // (ComputerUseApproval.tsx) so the model re-calls request_access and
  // gets the app list on the next call.
  if (tccState) {
    const req: CuPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: [],
      requestedFlags: {},
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      tccState,
    }
    await overrides.onPermissionRequest(req)

    // Re-check: the user may have granted in System Settings while the
    // dialog was up. The `tccState` arg is a pre-dialog snapshot — reading
    // it here would tell the model "not yet granted" even after the user
    // granted, and the model waits for confirmation instead of retrying.
    // The renderer's TCC panel already live-polls (computerUseTccStore);
    // this is the same re-check on the tool-result side.
    const recheck = await adapter.ensureOsPermissions()
    if (recheck.granted) {
      return errorResult(
        'macOS Accessibility and Screen Recording are now both granted. ' +
          'Call request_access again immediately — the next call will show ' +
          'the app selection list.',
      )
    }

    const perms = recheck as {
      granted: false
      accessibility: boolean
      screenRecording: boolean
    }
    const missing: string[] = []
    if (!perms.accessibility) missing.push('Accessibility')
    if (!perms.screenRecording) missing.push('Screen Recording')
    return errorResult(
      `macOS ${missing.join(' and ')} permission(s) not yet granted. ` +
        `The permission panel has been shown. Once the user grants the ` +
        `missing permission(s), call request_access again.`,
      'tcc_not_granted',
    )
  }

  const rawApps = args.apps
  if (!Array.isArray(rawApps) || !rawApps.every(a => typeof a === 'string')) {
    return errorResult('"apps" must be an array of strings.', 'bad_args')
  }
  const apps = rawApps as string[]

  const requestedFlags: Partial<CuGrantFlags> = {}
  if (typeof args.clipboardRead === 'boolean') {
    requestedFlags.clipboardRead = args.clipboardRead
  }
  if (typeof args.clipboardWrite === 'boolean') {
    requestedFlags.clipboardWrite = args.clipboardWrite
  }
  if (typeof args.systemKeyCombos === 'boolean') {
    requestedFlags.systemKeyCombos = args.systemKeyCombos
  }

  const {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  } = await buildAccessRequest(
    adapter,
    apps,
    overrides.allowedApps,
    new Set(overrides.userDeniedBundleIds),
    overrides.selectedDisplayId,
  )

  let dialogGranted: AppGrant[] = []
  let dialogDenied: Array<{
    bundleId: string
    reason: 'user_denied' | 'not_installed'
  }> = []
  let dialogFlags: CuGrantFlags = overrides.grantFlags

  if (needDialog.length > 0 || Object.keys(requestedFlags).length > 0) {
    const req: CuPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: needDialog,
      requestedFlags,
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      // Undefined when empty so the renderer skips the section cleanly.
      ...(willHide.length > 0 && {
        willHide,
        autoUnhideEnabled: adapter.getAutoUnhideEnabled(),
      }),
    }
    const response = await overrides.onPermissionRequest(req)
    dialogGranted = response.granted
    dialogDenied = response.denied
    dialogFlags = response.flags
  }

  // Do NOT return display geometry or coordinateMode. See COORDINATES.md
  // ("Never give the model a number that invites rescaling"). scaleCoord
  // already transforms server-side; the coordinate convention is baked into
  // the tool param descriptions at server-construction time.
  const allGranted = [...skipDialogGrants, ...dialogGranted]
  // Filter tieredApps to what was actually granted — if the user unchecked
  // Chrome in the dialog, don't explain Chrome's tier.
  const grantedBundleIds = new Set(allGranted.map(g => g.bundleId))
  const grantedTieredApps = tieredApps.filter(t =>
    grantedBundleIds.has(t.bundleId),
  )
  // Best-effort — grants are already persisted by wrappedPermissionHandler;
  // a listDisplays/findWindowDisplays failure (monitor hot-unplug, NAPI
  // error) must not tank the grant response. Same discipline as
  // buildMonitorNote's listDisplays try/catch.
  let windowLocations: Awaited<ReturnType<typeof buildWindowLocations>> = []
  try {
    windowLocations = await buildWindowLocations(adapter, allGranted)
  } catch (e) {
    adapter.logger.warn(
      `[computer-use] buildWindowLocations failed: ${String(e)}`,
    )
  }
  return okJson(
    {
      granted: allGranted,
      denied: dialogDenied,
      // Policy blocklist — precedes userDenied in precedence and response
      // order. No escape hatch; the agent is told to find another approach.
      ...(policyDenied.length > 0 && {
        policyDenied: {
          apps: policyDenied,
          guidance: buildPolicyDeniedGuidance(policyDenied),
        },
      }),
      // User-configured auto-deny — stripped before the dialog; this is the
      // agent's only signal that these apps exist but are user-blocked.
      ...(userDenied.length > 0 && {
        userDenied: {
          apps: userDenied,
          guidance: buildUserDeniedGuidance(userDenied),
        },
      }),
      // Upfront guidance so the model knows what each tier allows BEFORE
      // hitting the gate. Only included when something was tier-restricted.
      ...(grantedTieredApps.length > 0 && {
        tierGuidance: buildTierGuidanceMessage(grantedTieredApps),
      }),
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      // Where each granted app currently has open windows, across monitors.
      // Omitted when the app isn't running or has no normal windows.
      ...(windowLocations.length > 0 ? { windowLocations } : {}),
    },
    {
      // dialogGranted only — skipDialogGrants are idempotent re-grants of
      // apps already in the allowlist (no user action, dialog skips them).
      // Matching denied_count's this-call-only semantics.
      granted_count: dialogGranted.length,
      denied_count: dialogDenied.length,
      ...tierAssignmentTelemetry(grantedTieredApps),
    },
  )
}

/**
 * Sibling of `handleRequestAccess`. Same app-resolution + TCC-threading, but
 * routes to the teach approval dialog and fires `onTeachModeActivated` on
 * success. No grant-flag checkboxes (clipboard/systemKeys) in teach mode —
 * the tool schema omits those fields.
 *
 * Unlike `request_access`, this ALWAYS shows the dialog even when every
 * requested app is already granted. Teach mode is a distinct UX the user
 * must explicitly consent to (main window hides) — idempotent app grants
 * don't imply consent to being guided.
 */
export async function handleRequestTeachAccess(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  tccState: { accessibility: boolean; screenRecording: boolean } | undefined,
): Promise<CuCallToolResult> {
  if (!overrides.onTeachPermissionRequest) {
    return errorResult(
      'Teach mode is not available in this session.',
      'feature_unavailable',
    )
  }

  // Same as handleRequestAccess above — the dialog renders in the hidden
  // main window. Model re-calling request_teach_access mid-tour (to add
  // another app) is plausible since request_access docs say "call again
  // mid-session to add more apps" and this uses the same grant model.
  if (overrides.getTeachModeActive?.()) {
    return errorResult(
      'Teach mode is already active. To add more apps, end the current tour first, then call request_teach_access again with the full app list.',
      'teach_mode_conflict',
    )
  }

  const reason = requireString(args, 'reason')
  if (reason instanceof Error) return errorResult(reason.message, 'bad_args')

  // TCC-ungranted branch — identical to handleRequestAccess's. The renderer
  // shows the same TCC toggle panel regardless of which request tool got here.
  if (tccState) {
    const req: CuTeachPermissionRequest = {
      requestId: randomUUID(),
      reason,
      apps: [],
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      tccState,
    }
    await overrides.onTeachPermissionRequest(req)

    // Same re-check as handleRequestAccess — user may have granted while the
    // dialog was up, and the pre-dialog snapshot would mislead the model.
    const recheck = await adapter.ensureOsPermissions()
    if (recheck.granted) {
      return errorResult(
        'macOS Accessibility and Screen Recording are now both granted. ' +
          'Call request_teach_access again immediately — the next call will ' +
          'show the app selection list.',
      )
    }

    const perms = recheck as {
      granted: false
      accessibility: boolean
      screenRecording: boolean
    }
    const missing: string[] = []
    if (!perms.accessibility) missing.push('Accessibility')
    if (!perms.screenRecording) missing.push('Screen Recording')
    return errorResult(
      `macOS ${missing.join(' and ')} permission(s) not yet granted. ` +
        `The permission panel has been shown. Once the user grants the ` +
        `missing permission(s), call request_teach_access again.`,
      'tcc_not_granted',
    )
  }

  const rawApps = args.apps
  if (!Array.isArray(rawApps) || !rawApps.every(a => typeof a === 'string')) {
    return errorResult('"apps" must be an array of strings.', 'bad_args')
  }
  const apps = rawApps as string[]

  const {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  } = await buildAccessRequest(
    adapter,
    apps,
    overrides.allowedApps,
    new Set(overrides.userDeniedBundleIds),
    overrides.selectedDisplayId,
  )

  // All requested apps were user-denied (or unresolvable) and none pre-granted
  // — skip the dialog entirely. Without this, onTeachPermissionRequest fires
  // with apps:[] and the user sees an empty approval dialog where Allow and
  // Deny produce the same result (granted=[] → teachModeActive stays false).
  // handleRequestAccess has the equivalent guard at the needDialog.length
  // check; teach didn't need one before user-deny because needDialog=[]
  // previously implied skipDialogGrants.length > 0 (all-already-granted).
  if (needDialog.length === 0 && skipDialogGrants.length === 0) {
    return okJson(
      {
        granted: [],
        denied: [],
        ...(policyDenied.length > 0 && {
          policyDenied: {
            apps: policyDenied,
            guidance: buildPolicyDeniedGuidance(policyDenied),
          },
        }),
        ...(userDenied.length > 0 && {
          userDenied: {
            apps: userDenied,
            guidance: buildUserDeniedGuidance(userDenied),
          },
        }),
        teachModeActive: false,
        screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
      },
      { granted_count: 0, denied_count: 0 },
    )
  }

  const req: CuTeachPermissionRequest = {
    requestId: randomUUID(),
    reason,
    apps: needDialog,
    screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
    ...(willHide.length > 0 && {
      willHide,
      autoUnhideEnabled: adapter.getAutoUnhideEnabled(),
    }),
  }
  const response = await overrides.onTeachPermissionRequest(req)

  const granted = [...skipDialogGrants, ...response.granted]
  // Gate on explicit dialog consent, NOT on merged grant length.
  // skipDialogGrants are pre-existing idempotent app grants — they don't
  // imply the user said yes to THIS dialog. Without the userConsented
  // check, Deny would still activate teach mode whenever any requested
  // app was previously granted (worst case: needDialog=[] → Allow and
  // Deny payloads are structurally identical).
  const teachModeActive = response.userConsented === true && granted.length > 0
  if (teachModeActive) {
    overrides.onTeachModeActivated?.()
  }

  const grantedBundleIds = new Set(granted.map(g => g.bundleId))
  const grantedTieredApps = tieredApps.filter(t =>
    grantedBundleIds.has(t.bundleId),
  )

  return okJson(
    {
      granted,
      denied: response.denied,
      ...(policyDenied.length > 0 && {
        policyDenied: {
          apps: policyDenied,
          guidance: buildPolicyDeniedGuidance(policyDenied),
        },
      }),
      ...(userDenied.length > 0 && {
        userDenied: {
          apps: userDenied,
          guidance: buildUserDeniedGuidance(userDenied),
        },
      }),
      ...(grantedTieredApps.length > 0 && {
        tierGuidance: buildTierGuidanceMessage(grantedTieredApps),
      }),
      teachModeActive,
      screenshotFiltering: adapter.executor.capabilities.screenshotFiltering,
    },
    {
      // response.granted only — skipDialogGrants are idempotent re-grants.
      // See handleRequestAccess's parallel comment.
      granted_count: response.granted.length,
      denied_count: response.denied.length,
      ...tierAssignmentTelemetry(grantedTieredApps),
    },
  )
}
