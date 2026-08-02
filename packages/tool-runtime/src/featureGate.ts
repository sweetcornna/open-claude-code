export interface FeatureGateHost {
  getFeatureValue_CACHED_MAY_BE_STALE<T>(feature: string, defaultValue: T): T
  getFeatureValue_CACHED_WITH_REFRESH<T>(
    feature: string,
    defaultValue: T,
    refreshIntervalMs: number,
  ): T
}

let host: FeatureGateHost | null = null

export function registerFeatureGateHost(h: FeatureGateHost): void {
  host = h
}

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(
  feature: string,
  defaultValue: T,
): T {
  return host
    ? host.getFeatureValue_CACHED_MAY_BE_STALE(feature, defaultValue)
    : defaultValue
}

/**
 * @deprecated Use getFeatureValue_CACHED_MAY_BE_STALE instead.
 */
export function getFeatureValue_CACHED_WITH_REFRESH<T>(
  feature: string,
  defaultValue: T,
  refreshIntervalMs: number,
): T {
  return host
    ? host.getFeatureValue_CACHED_WITH_REFRESH(
        feature,
        defaultValue,
        refreshIntervalMs,
      )
    : defaultValue
}
