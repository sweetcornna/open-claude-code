import type { ScreenshotResult } from '../executor.js'
import type { CallToolResult } from '@modelcontextprotocol/server'

/**
 * Categorical error classes for the cu_tool_call telemetry event. Never
 * free text — error messages may contain file paths / app content (PII).
 */
export type CuErrorKind =
  | 'allowlist_empty'
  | 'tcc_not_granted'
  | 'cu_lock_held'
  | 'teach_mode_conflict'
  | 'teach_mode_not_active'
  | 'executor_threw'
  | 'capture_failed'
  | 'app_denied' // no longer emitted (tiered model replaced hard-deny); kept for schema compat
  | 'bad_args' // malformed tool args (type/shape/range/unknown value)
  | 'app_not_granted' // target app not in session allowlist (distinct from allowlist_empty)
  | 'tier_insufficient' // app in allowlist but at a tier too low for the action
  | 'feature_unavailable' // tool callable but session not wired for it
  | 'state_conflict' // wrong state for action (call sequence, mouse already held)
  | 'grant_flag_required' // action needs a grant flag (systemKeyCombos, clipboard*) from request_access
  | 'display_error' // display enumeration failed (platform)
  | 'launch_failed' // failed to launch an external process (e.g. terminal)
  | 'element_not_found' // UI element not found (e.g. window, automation element)
  | 'other'

/**
 * Telemetry payload piggybacked on the result — populated by handlers,
 * consumed and stripped by the host wrapper (serverDef.ts) before the
 * result goes to the SDK. Same pattern as `screenshot`.
 */
export interface CuCallTelemetry {
  /** request_access / request_teach_access: apps NEWLY granted in THIS call
   *  (does NOT include idempotent re-grants of already-allowed apps). */
  granted_count?: number
  /** request_access / request_teach_access: apps denied in THIS call */
  denied_count?: number
  /** request_access / request_teach_access: apps safety-denied (browser) this call */
  denied_browser_count?: number
  /** request_access / request_teach_access: apps safety-denied (terminal) this call */
  denied_terminal_count?: number
  /** Categorical error class (only set when isError) */
  error_kind?: CuErrorKind
}

/**
 * `CallToolResult` augmented with the screenshot payload. `bindSessionContext`
 * reads `result.screenshot` after a `screenshot` tool call and stashes it in a
 * closure cell for the next pixel-validation. MCP clients never see this
 * field — the host wrapper strips it before returning to the SDK.
 */
export type CuCallToolResult = CallToolResult & {
  screenshot?: ScreenshotResult
  /** Piggybacked telemetry — stripped by the host wrapper before SDK return. */
  telemetry?: CuCallTelemetry
}

// ---------------------------------------------------------------------------
// Small result helpers (mirror of chrome-mcp's inline `{content, isError}`)
// ---------------------------------------------------------------------------

export function errorResult(
  text: string,
  errorKind?: CuErrorKind,
): CuCallToolResult {
  return {
    content: [{ type: 'text', text }],
    isError: true,
    telemetry: errorKind ? { error_kind: errorKind } : undefined,
  }
}

export function okText(text: string): CuCallToolResult {
  return { content: [{ type: 'text', text }] }
}

export function okJson(
  obj: unknown,
  telemetry?: CuCallTelemetry,
): CuCallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(obj) }],
    telemetry,
  }
}

// ---------------------------------------------------------------------------
// Arg validation — lightweight, no zod (mirrors chrome-mcp's cast-and-check)
// ---------------------------------------------------------------------------

export function asRecord(args: unknown): Record<string, unknown> {
  if (typeof args === 'object' && args !== null) {
    return args as Record<string, unknown>
  }
  return {}
}

export function requireNumber(
  args: Record<string, unknown>,
  key: string,
): number | Error {
  const v = args[key]
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return new Error(`"${key}" must be a finite number.`)
  }
  return v
}

export function requireString(
  args: Record<string, unknown>,
  key: string,
): string | Error {
  const v = args[key]
  if (typeof v !== 'string') {
    return new Error(`"${key}" must be a string.`)
  }
  return v
}

/**
 * Extract (x, y) from `coordinate: [x, y]` tuple.
 * array of length 2, both non-negative numbers.
 */
export function extractCoordinate(
  args: Record<string, unknown>,
  paramName: string = 'coordinate',
): [number, number] | Error {
  const coord = args[paramName]
  if (coord === undefined) {
    return new Error(`${paramName} is required`)
  }
  if (!Array.isArray(coord) || coord.length !== 2) {
    return new Error(`${paramName} must be an array of length 2`)
  }
  const [x, y] = coord
  if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || y < 0) {
    return new Error(`${paramName} must be a tuple of non-negative numbers`)
  }
  return [x, y]
}
