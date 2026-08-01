import { getDefaultTierForApp, isPolicyDenied } from '../deniedApps.js'
import type { InstalledApp } from '../executor.js'
import { SENTINEL_BUNDLE_IDS } from '../sentinelApps.js'
import type {
  AppGrant,
  ComputerUseHostAdapter,
  ResolvedAppRequest,
} from '../types.js'

// ---------------------------------------------------------------------------
// request_access helpers
// ---------------------------------------------------------------------------

/** Reverse-DNS-ish: contains at least one dot, no spaces, no slashes. Lets
 * raw bundle IDs pass through resolution. */
export const REVERSE_DNS_RE = /^[A-Za-z0-9][\w.-]*\.[A-Za-z0-9][\w.-]*$/

export function looksLikeBundleId(s: string): boolean {
  return REVERSE_DNS_RE.test(s) && !s.includes(' ')
}

export function resolveRequestedApps(
  requestedNames: string[],
  installed: InstalledApp[],
  alreadyGrantedBundleIds: ReadonlySet<string>,
): ResolvedAppRequest[] {
  const byLowerDisplayName = new Map<string, InstalledApp>()
  const byBundleId = new Map<string, InstalledApp>()
  for (const app of installed) {
    byBundleId.set(app.bundleId, app)
    // Last write wins on collisions. Ambiguous-name handling (multiple
    // candidates in the dialog) is plan-documented but deferred — the
    // InstalledApps enumerator dedupes by bundle ID, so true display-name
    // collisions are rare. TODO(chicago, post-P1): surface all candidates.
    byLowerDisplayName.set(app.displayName.toLowerCase(), app)
  }

  return requestedNames.map((requested): ResolvedAppRequest => {
    let resolved: InstalledApp | undefined
    if (looksLikeBundleId(requested)) {
      resolved = byBundleId.get(requested)
    }
    if (!resolved) {
      resolved = byLowerDisplayName.get(requested.toLowerCase())
    }
    // Windows fuzzy matching: strip .exe suffix, try substring match
    if (!resolved) {
      const clean = requested
        .toLowerCase()
        .replace(/\.exe$/, '')
        .trim()
      // Try: "chrome" matches "Google Chrome", "notepad" matches "Notepad"
      for (const [name, app] of byLowerDisplayName) {
        if (name.includes(clean) || clean.includes(name)) {
          resolved = app
          break
        }
      }
    }
    const bundleId = resolved?.bundleId
    // When unresolved AND the requested string looks like a bundle ID, use it
    // directly for tier lookup (e.g. "company.thebrowser.Browser" with Arc not
    // installed — the reverse-DNS string won't match any display-name substring).
    const bundleIdCandidate =
      bundleId ?? (looksLikeBundleId(requested) ? requested : undefined)
    return {
      requestedName: requested,
      resolved,
      isSentinel: bundleId ? SENTINEL_BUNDLE_IDS.has(bundleId) : false,
      alreadyGranted: bundleId ? alreadyGrantedBundleIds.has(bundleId) : false,
      proposedTier: getDefaultTierForApp(
        bundleIdCandidate,
        resolved?.displayName ?? requested,
      ),
    }
  })
}

/**
 * For each granted app with open windows, which displays those windows are
 * on. Single-monitor setups return an empty array (no multi-monitor signal
 * to give). Apps not running, or running with no normal windows, are omitted.
 */
export async function buildWindowLocations(
  adapter: ComputerUseHostAdapter,
  granted: AppGrant[],
): Promise<
  Array<{
    bundleId: string
    displayName: string
    displays: Array<{ id: number; label?: string; isPrimary?: boolean }>
  }>
> {
  if (granted.length === 0) return []

  const displays = await adapter.executor.listDisplays()
  if (displays.length <= 1) return []

  const grantedBundleIds = granted.map(g => g.bundleId)
  const windowLocs = await adapter.executor.findWindowDisplays(grantedBundleIds)
  const displayById = new Map(displays.map(d => [d.displayId, d]))
  const idsByBundle = new Map(windowLocs.map(w => [w.bundleId, w.displayIds]))

  const out = []
  for (const g of granted) {
    const displayIds = idsByBundle.get(g.bundleId)
    if (!displayIds || displayIds.length === 0) continue
    out.push({
      bundleId: g.bundleId,
      displayName: g.displayName,
      displays: displayIds.map(id => {
        const d = displayById.get(id)
        return { id, label: d?.label, isPrimary: d?.isPrimary }
      }),
    })
  }
  return out
}

/**
 * Shared app-resolution + partition + hide-preview pipeline. Extracted from
 * `handleRequestAccess` so `handleRequestTeachAccess` can call the same path.
 *
 * Does the full app-name→InstalledApp resolution, assigns each a tier
 * (browser→"read", terminal/IDE→"click", else "full" — see deniedApps.ts),
 * splits into already-granted (skip the dialog, preserve grantedAt+tier) vs
 * need-dialog, and computes the willHide preview. Unlike the previous
 * hard-deny model, ALL apps proceed to the dialog; the tier just constrains
 * what actions are allowed once granted.
 */
/** An app assigned a restricted tier (not `"full"`). Used to build the
 *  guidance message telling the model what it can/can't do. */
export interface TieredApp {
  bundleId: string
  displayName: string
  /** Never `"full"` — only restricted tiers are collected. */
  tier: 'read' | 'click'
}

export interface AccessRequestParts {
  needDialog: ResolvedAppRequest[]
  skipDialogGrants: AppGrant[]
  willHide: Array<{ bundleId: string; displayName: string }>
  /** Resolved apps with `proposedTier !== "full"` — for the guidance text.
   *  Unresolved apps are omitted (they go to `denied` with `not_installed`).  */
  tieredApps: TieredApp[]
  /** Apps stripped by the user's Settings auto-deny list. Surfaced in the
   *  response with guidance; never reach the dialog. */
  userDenied: Array<{ requestedName: string; displayName: string }>
  /** Apps stripped by the baked-in policy blocklist (streaming/music/ebooks,
   *  etc. — `deniedApps.isPolicyDenied`). Precedence over userDenied. */
  policyDenied: Array<{ requestedName: string; displayName: string }>
}

export async function buildAccessRequest(
  adapter: ComputerUseHostAdapter,
  apps: string[],
  allowedApps: AppGrant[],
  userDeniedBundleIds: ReadonlySet<string>,
  selectedDisplayId?: number,
): Promise<AccessRequestParts> {
  const alreadyGranted = new Set(allowedApps.map(g => g.bundleId))
  const installed = await adapter.executor.listInstalledApps()
  const resolved = resolveRequestedApps(apps, installed, alreadyGranted)

  // Policy-level auto-deny (baked-in, not user-configurable). Stripped
  // before userDenied — checks bundle ID AND display name (covers
  // unresolved requests). Precedence: policy > user setting > tier.
  const policyDenied: Array<{ requestedName: string; displayName: string }> = []
  const afterPolicy: typeof resolved = []
  for (const r of resolved) {
    const displayName = r.resolved?.displayName ?? r.requestedName
    if (isPolicyDenied(r.resolved?.bundleId, displayName)) {
      policyDenied.push({ requestedName: r.requestedName, displayName })
    } else {
      afterPolicy.push(r)
    }
  }

  // User-configured auto-deny (Settings → Desktop app → Computer Use).
  // Stripped BEFORE
  // tier assignment — these never reach the dialog regardless of category.
  // Bundle-ID match only (the Settings UI picks from installed apps, which
  // always have a bundle ID). Unresolved requests pass through to the tier
  // system; the user can't preemptively deny an app that isn't installed.
  const userDenied: Array<{ requestedName: string; displayName: string }> = []
  const surviving: typeof afterPolicy = []
  for (const r of afterPolicy) {
    if (r.resolved && userDeniedBundleIds.has(r.resolved.bundleId)) {
      userDenied.push({
        requestedName: r.requestedName,
        displayName: r.resolved.displayName,
      })
    } else {
      surviving.push(r)
    }
  }

  // Collect resolved apps with a restricted tier for the guidance message.
  // Unresolved apps with a restricted tier (e.g. model asks for "Chrome" but
  // it's not installed) are omitted — they'll end up in the `denied` list
  // with reason "not_installed" and the model will see that instead.
  const tieredApps: TieredApp[] = []
  for (const r of surviving) {
    if (r.proposedTier === 'full' || !r.resolved) continue
    tieredApps.push({
      bundleId: r.resolved.bundleId,
      displayName: r.resolved.displayName,
      tier: r.proposedTier,
    })
  }

  // Idempotence: apps that are already granted skip the dialog and are
  // merged into the `granted` response. Existing grants keep their tier
  // (which may differ from the current proposedTier if policy changed).
  const skipDialog = surviving.filter(r => r.alreadyGranted)
  const needDialog = surviving.filter(r => !r.alreadyGranted)

  // Populate icons only for what the dialog will actually show. Sequential
  // awaits are fine — the Swift module is cached (listInstalledApps above
  // loaded it), each N-API call is synchronous, and the darwin executor
  // memoizes by path. Failures leave iconDataUrl undefined; renderer falls
  // back to a grey box.
  for (const r of needDialog) {
    if (!r.resolved) continue
    try {
      r.resolved.iconDataUrl = await adapter.executor.getAppIcon(
        r.resolved.path,
      )
    } catch {
      // leave undefined
    }
  }

  const now = Date.now()
  const skipDialogGrants: AppGrant[] = skipDialog
    .filter(r => r.resolved)
    .map(r => {
      // Reuse the existing grant (preserving grantedAt + tier) rather than
      // synthesizing a new one — keeps Settings-page "Granted 3m ago" honest.
      const existing = allowedApps.find(
        g => g.bundleId === r.resolved!.bundleId,
      )
      return (
        existing ?? {
          bundleId: r.resolved!.bundleId,
          displayName: r.resolved!.displayName,
          grantedAt: now,
          tier: r.proposedTier,
        }
      )
    })

  // Preview what will be hidden if the user approves exactly the requested
  // set plus what they already have. All tiers are visible, so everything
  // resolved goes in the exempt set.
  const exemptForPreview = [
    ...allowedApps.map(a => a.bundleId),
    ...surviving.filter(r => r.resolved).map(r => r.resolved!.bundleId),
  ]
  const willHide = await adapter.executor.previewHideSet(
    exemptForPreview,
    selectedDisplayId,
  )

  return {
    needDialog,
    skipDialogGrants,
    willHide,
    tieredApps,
    userDenied,
    policyDenied,
  }
}
