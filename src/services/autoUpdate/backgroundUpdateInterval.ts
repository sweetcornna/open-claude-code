/**
 * How often the background loops re-check for updates.
 *
 * 30 minutes rather than something tighter: a check costs an `npm view` round
 * trip per loop, and a released version is not worth finding within seconds.
 * The first check is deliberately much sooner (see the per-service delay
 * constants) so a long-lived session still picks up a release it started
 * before.
 */
const DEFAULT_BACKGROUND_UPDATE_INTERVAL_MS = 30 * 60 * 1000
const MIN_BACKGROUND_UPDATE_INTERVAL_MS = 60_000

export function resolveBackgroundUpdateIntervalMs(
  env: NodeJS.ProcessEnv,
): number {
  const raw = env.OCC_UPDATE_CHECK_INTERVAL_MS?.trim()
  if (!raw) {
    return DEFAULT_BACKGROUND_UPDATE_INTERVAL_MS
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return DEFAULT_BACKGROUND_UPDATE_INTERVAL_MS
  }

  return Math.max(MIN_BACKGROUND_UPDATE_INTERVAL_MS, Math.trunc(parsed))
}
