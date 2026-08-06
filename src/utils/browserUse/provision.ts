/**
 * Getting browser-use to a working state.
 *
 * browser-use is a Python tool, so unlike an npm dependency occ cannot ship it.
 * Three things have to be true before `--chrome` works:
 *
 *   1. `uvx` on PATH — the launcher
 *   2. the `browser-use[cli]` package fetched — uvx does this on first run,
 *      which is a slow, silent, network-bound surprise in the middle of a
 *      browser action unless it happened earlier
 *   3. Chrome or Chromium installed — checked separately by chromeVersion.ts
 *
 * This module covers 1 and 2 so the installer, the `/chrome` panel and
 * `occ doctor` all report and repair the same thing.
 */
import { captureProcess } from '../process/spawnPortable.js'
import { whichSync } from '../process/which.js'
import { logForDebugging } from '../telemetry/debug.js'

/** Package spec `uvx` resolves. `[cli]` carries the console entry points. */
export const BROWSER_USE_UVX_SPEC = 'browser-use[cli]'

/**
 * Module that actually implements the MCP server.
 *
 * Not `browser-use --mcp`: that flag is what browser-use's own documentation
 * says, but it does not exist in 0.13.7 — the CLI offers only
 * `--version`, `--doctor`, `auth …` and `skill`. The module below is the real
 * entry point, confirmed by running an MCP `initialize` handshake against it.
 */
export const BROWSER_USE_MCP_MODULE = 'browser_use.mcp.server'

/** Fetching the package on a cold cache pulls a browser stack; be generous. */
const WARM_TIMEOUT_MS = 300_000

export type BrowserUseReadiness = {
  /** `uvx` was found on PATH. */
  hasUvx: boolean
  /** The package resolved without a network fetch, i.e. it is already cached. */
  packageReady: boolean
  /** One line of guidance, or null when nothing needs saying. */
  note: string | null
}

/** Can browser-use be launched at all? */
export function isBrowserUseAvailable(): boolean {
  return whichSync('uvx') !== null
}

/**
 * Check readiness without changing anything.
 *
 * `--offline` is what makes this a *check*: uv resolves from its cache and
 * fails rather than silently downloading, so this cannot turn into the slow
 * first run it exists to detect.
 */
export async function checkBrowserUseReadiness(): Promise<BrowserUseReadiness> {
  if (!isBrowserUseAvailable()) {
    return {
      hasUvx: false,
      packageReady: false,
      note: 'uvx not found. Install uv: https://docs.astral.sh/uv/getting-started/installation/',
    }
  }
  // Imports the MCP module rather than running the CLI: what has to work is
  // the thing occ actually launches. `--offline` keeps this a check — uv
  // resolves from cache and fails instead of silently downloading, so this
  // cannot become the slow first run it exists to detect.
  const { exitCode } = await captureProcess(
    [
      'uvx',
      '--offline',
      '--from',
      BROWSER_USE_UVX_SPEC,
      'python',
      '-c',
      `import ${BROWSER_USE_MCP_MODULE}`,
    ],
    { timeoutMs: 60_000 },
  )
  if (exitCode === 0) {
    return { hasUvx: true, packageReady: true, note: null }
  }
  return {
    hasUvx: true,
    packageReady: false,
    note: 'browser-use is not cached yet; the first browser action will download it. Run `occ chrome` to fetch it now.',
  }
}

/**
 * Fetch browser-use into uv's cache so the first browser action is not a
 * multi-minute download.
 *
 * Returns what happened rather than throwing: every caller here is a setup
 * path where a failed pre-warm is a slower first run, not an error.
 */
export async function warmBrowserUse(): Promise<{
  ok: boolean
  detail: string
}> {
  if (!isBrowserUseAvailable()) {
    return {
      ok: false,
      detail:
        'uvx not found. Install uv first: https://docs.astral.sh/uv/getting-started/installation/',
    }
  }
  const { exitCode, stderr, timedOut } = await captureProcess(
    [
      'uvx',
      '--from',
      BROWSER_USE_UVX_SPEC,
      'python',
      '-c',
      `import ${BROWSER_USE_MCP_MODULE}`,
    ],
    { timeoutMs: WARM_TIMEOUT_MS },
  )
  if (timedOut) {
    return { ok: false, detail: 'timed out fetching browser-use' }
  }
  if (exitCode !== 0) {
    logForDebugging(`[browser-use] warm failed: ${stderr}`)
    return {
      ok: false,
      detail: stderr.trim().split('\n').pop() ?? 'unknown error',
    }
  }
  return { ok: true, detail: 'browser-use is ready' }
}
