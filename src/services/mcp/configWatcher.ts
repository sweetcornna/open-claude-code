/**
 * Watches a fixed set of files and reports when any of them changes.
 *
 * Why this exists: the connection effect in useManageMCPConnections re-runs on
 * session change and /reload-plugins, and nothing else. Editing `.mcp.json`
 * mid-session therefore had no effect at all — a server deleted from the file
 * kept its stdio child process alive and its tools callable until the user
 * restarted or ran /clear. Reclaiming the process is already implemented
 * (excludeStalePluginClients → clearServerCache → transport cleanup); the only
 * missing piece was something telling the effect to look again.
 *
 * The paths come from the caller (getMcpConfigWatchPaths in ./utils.ts, which
 * already owns the knowledge of where MCP definitions live) rather than being
 * derived here. That keeps this module a leaf — importing getGlobalClaudeFile
 * here closes a cycle through utils/config, which check:cycles catches.
 *
 * Uses fs.watchFile rather than chokidar: the target is a known, small, fixed
 * list of individual files, so stat polling avoids directory traversal, the
 * ancestor-does-not-exist-yet problem, and chokidar's atomic-write races. It
 * also fires for files that do not exist yet, which is what makes "user creates
 * .mcp.json for the first time" work.
 */
import { unwatchFile, watchFile, type Stats } from 'node:fs'
import { logForDebugging } from '../../utils/telemetry/debug.js'

/**
 * Stat poll interval. Matches the global config freshness watcher — MCP config
 * edits are a human-scale event, so a second of latency is irrelevant and the
 * stat runs on the libuv threadpool rather than the main thread.
 */
const POLL_INTERVAL_MS = 1000

/**
 * Coalescing window. An editor writing a file can produce several stat-visible
 * transitions (truncate, then write), and a chain of `.mcp.json` files may be
 * rewritten together by a script. Reconnecting per event would tear down and
 * respawn servers repeatedly.
 */
const DEBOUNCE_MS = 250

/**
 * Start watching. Calls `onChange` (debounced) whenever a watched file is
 * created, modified, or deleted. Returns a stop function; calling it twice is
 * harmless.
 */
export function startMcpConfigWatcher(
  paths: readonly string[],
  onChange: () => void,
): () => void {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const fire = (path: string): void => {
    if (stopped) return
    logForDebugging(`MCP config change detected: ${path}`)
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      if (!stopped) onChange()
    }, DEBOUNCE_MS)
  }

  // watchFile's first callback can arrive with a synthetic "previous" state, and
  // a missing file reports mtimeMs 0 rather than erroring. Comparing both mtime
  // and existence keeps creation and deletion distinguishable from a no-op tick.
  const listeners = paths.map(path => {
    const listener = (curr: Stats, prev: Stats): void => {
      const existedBefore = prev.mtimeMs !== 0
      const existsNow = curr.mtimeMs !== 0
      if (existedBefore === existsNow && curr.mtimeMs === prev.mtimeMs) return
      fire(path)
    }
    watchFile(path, { interval: POLL_INTERVAL_MS, persistent: false }, listener)
    return { path, listener }
  })

  return () => {
    if (stopped) return
    stopped = true
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    for (const { path, listener } of listeners) unwatchFile(path, listener)
  }
}
