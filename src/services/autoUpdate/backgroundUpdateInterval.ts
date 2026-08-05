const DEFAULT_BACKGROUND_UPDATE_INTERVAL_MS = 5 * 60 * 1000
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
