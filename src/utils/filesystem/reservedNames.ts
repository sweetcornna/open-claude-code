/**
 * Windows device names, for path-segment sanitizers.
 *
 * Zero-dependency leaf.
 */

/**
 * Names Windows reserves for devices at *every* directory level, with or
 * without an extension: `nul`, `nul.txt` and `C:\anything\nul` all address the
 * null device rather than a file.
 *
 * The sanitizers that build directory names from user-controlled strings
 * (plugin ids, teammate names, task ids, session paths) only replaced
 * characters outside `[A-Za-z0-9_-]`. Every one of these names survives that
 * filter intact, so a plugin or teammate called `nul` produced a path whose
 * creation silently succeeds and whose contents can never be read back.
 */
const RESERVED = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`),
])

/**
 * Make one path segment safe to create on Windows.
 *
 * Applied on every platform on purpose: these paths end up in configs and
 * caches that get synced or copied between machines, and a name that is only
 * legal on the machine that made it is a trap for the next one.
 */
export function avoidReservedName(segment: string): string {
  // Extension included: `nul.txt` is the device too.
  const stem = segment.split('.')[0] ?? ''
  if (RESERVED.has(stem.toLowerCase())) {
    return `_${segment}`
  }
  // Windows also rejects a trailing dot or space on any segment.
  return segment.replace(/[. ]+$/, '')
}
