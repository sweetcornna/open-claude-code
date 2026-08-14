/**
 * One-time removal of the remote feature-gate payload occ used to keep in the
 * global config.
 *
 * Until this release, every successful GrowthBook fetch wholesale-wrote its
 * evaluated payload into `cachedGrowthBookFeatures`, and nothing ever removed
 * it — `/logout` cleared only the in-memory map. A machine that ran occ once
 * while signed in to Anthropic was left with a frozen experiment assignment
 * (491 gates on the install this was found on) answering every unpinned gate
 * for the life of the install, across upgrades, forever. Two of those gates
 * were live functional regressions; see LOCAL_GATE_DEFAULTS in growthbook.ts.
 *
 * growthbook.ts no longer writes that key. This removes what is already there.
 *
 * WHY NO "already purged" FLAG: nothing writes these keys back, so the purge
 * is self-limiting — after the one run that finds them, every later call reads
 * the absent key and returns without touching disk. A flag would only add a
 * config field to be wrong about.
 *
 * WHY AT STARTUP RATHER THAN IN `occ doctor` OR THE FIRST-RUN MIGRATION:
 * doctor and the migration are both things a user has to go and do, and the
 * population that needs this is exactly the population that has no reason to
 * suspect anything is wrong. The first-run migration additionally never fires
 * for the affected installs — they are past first run by definition, which is
 * how they came to have the payload at all.
 *
 * The write goes through saveGlobalConfig(), which derives its path from
 * src/config/paths.ts. Do not reach for the file directly.
 */

import { getGlobalConfig, saveGlobalConfig } from '../../utils/config/config.js'

/**
 * Drop any remote-authored gate payload from the global config.
 *
 * Both keys are payloads served by Anthropic and cached locally:
 * `cachedGrowthBookFeatures` is GrowthBook's, `cachedStatsigGates` is the
 * pre-GrowthBook Statsig equivalent that the migration readers still consult
 * (checkStatsigFeatureGate_CACHED_MAY_BE_STALE, checkSecurityRestrictionGate).
 * `cachedStatsigGates` is typed non-optional, so it is emptied rather than
 * deleted.
 *
 * @returns true if something was removed (i.e. a write happened).
 */
export function purgeCachedRemoteGates(): boolean {
  let config: ReturnType<typeof getGlobalConfig>
  try {
    config = getGlobalConfig()
  } catch {
    // getGlobalConfig() throws before enableConfigs(). Nothing to purge yet,
    // and the next startup will get it.
    return false
  }

  const hasGrowthBook =
    config.cachedGrowthBookFeatures !== undefined &&
    Object.keys(config.cachedGrowthBookFeatures).length > 0
  const hasStatsig =
    config.cachedStatsigGates !== undefined &&
    Object.keys(config.cachedStatsigGates).length > 0

  if (!hasGrowthBook && !hasStatsig) {
    return false
  }

  // `undefined` rather than a destructuring delete: saveGlobalConfig's test
  // path Object.assign()s the result onto the existing object, where a removed
  // key is simply not seen. Serialising to JSON drops it either way.
  saveGlobalConfig(current => ({
    ...current,
    cachedGrowthBookFeatures: undefined,
    cachedStatsigGates: {},
  }))
  return true
}
