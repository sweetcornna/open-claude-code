/**
 * Forced-GC policy for the headless (`-p`) periodic memory tick.
 *
 * The tick fires once per second and decides whether to run a *synchronous*
 * major collection (`Bun.gc(true)`) instead of the cheap incremental one.
 *
 * The threshold used to be 350MB, which sits far below the process's own RSS
 * baseline of ~682MB measured in docs/memory-peak-analysis.md (see that
 * document's P1 item #17). A threshold below the baseline is never not
 * exceeded, so headless mode forced a blocking major GC on every single tick,
 * for the entire life of the process.
 */

/**
 * 682MB baseline plus the 120-320MB peaks an ordinary turn tail produces lands
 * around 1000MB, so 1024MB keeps normal turns quiet while the pathological
 * 1.8GB worst case documented in docs/memory-peak-analysis.md still trips it.
 * The doc suggests "800MB+", but 800MB re-latches during ordinary turns.
 */
export const FORCED_GC_RSS_THRESHOLD = 1024 * 1024 * 1024

/**
 * Bun/mimalloc never returns freed pages to the OS, so RSS behaves as a
 * high-water mark: once *any* threshold is crossed it stays crossed and the
 * size check alone latches on permanently. The cooldown is what actually bounds
 * the cost — a forced major GC runs at most once per 30s however high RSS
 * climbs, and every other tick falls through to the incremental collection.
 */
export const FORCED_GC_COOLDOWN_MS = 30_000

/**
 * Whether this tick should force a major GC.
 *
 * @param rssBytes Current resident set size, in bytes.
 * @param nowMs Current timestamp, in ms.
 * @param lastForcedAtMs Timestamp of the previous forced GC, or undefined if
 *   none has run yet in this process.
 */
export function shouldForceGc(
  rssBytes: number,
  nowMs: number,
  lastForcedAtMs: number | undefined,
): boolean {
  if (rssBytes <= FORCED_GC_RSS_THRESHOLD) {
    return false
  }
  if (lastForcedAtMs === undefined) {
    return true
  }
  return nowMs - lastForcedAtMs >= FORCED_GC_COOLDOWN_MS
}
