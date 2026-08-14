/**
 * Screen-reader mode: render flat text with no decorative borders and no
 * animations.
 *
 * This module owns *only* the resolution of the three input channels. The
 * render layer consumes `isScreenReaderMode()`; nothing here touches Ink.
 *
 * Priority (highest first), matching upstream:
 *   1. CLI flag  `--ax-screen-reader`
 *   2. env       `CLAUDE_AX_SCREEN_READER` (tri-state: `0`/`false` turns it
 *                *off* even when settings ask for it)
 *   3. settings  `axScreenReader`
 *
 * The flag channel has two feeds. `setScreenReaderModeOverride()` is called
 * from the Commander action once options are parsed, but plenty of startup
 * code runs *before* that — so an unset override falls back to scanning
 * argv, the same trick `isBareMode()` uses. Once the action has run, the
 * override is authoritative (a parsed `--ax-screen-reader=false` must be
 * able to beat a stray argv match).
 *
 * The result is memoized because it is read from render paths; call
 * `resetScreenReaderModeForTesting()` to clear it.
 */
import { isEnvDefinedFalsy, isEnvTruthy } from '../config/envUtils.js'
import { getInitialSettings } from '../settings/settings.js'

export const SCREEN_READER_FLAG = '--ax-screen-reader'
export const SCREEN_READER_ENV_VAR = 'CLAUDE_AX_SCREEN_READER'

/** Which channel turned screen-reader mode on. */
export type ScreenReaderSource = 'flag' | 'env' | 'settings'

export type ScreenReaderInputs = {
  /** Parsed CLI flag. `undefined` when the flag was not supplied. */
  flag: boolean | undefined
  /** Raw `CLAUDE_AX_SCREEN_READER` value. `undefined` when unset. */
  env: string | undefined
  /** `settings.axScreenReader`. */
  settings: boolean | undefined
}

export type ScreenReaderResolution = {
  enabled: boolean
  /** Only set when `enabled` is true. */
  source: ScreenReaderSource | undefined
}

/**
 * Pure resolver. Exported so tests can pin the precedence table without
 * touching `process.argv`, `process.env`, or the settings cache.
 */
export function resolveScreenReaderMode(
  inputs: ScreenReaderInputs,
): ScreenReaderResolution {
  if (inputs.flag !== undefined) {
    return { enabled: inputs.flag, source: inputs.flag ? 'flag' : undefined }
  }
  if (inputs.env !== undefined && inputs.env !== '') {
    // Tri-state: an explicitly falsy env value wins over settings.
    if (isEnvDefinedFalsy(inputs.env))
      return { enabled: false, source: undefined }
    if (isEnvTruthy(inputs.env)) return { enabled: true, source: 'env' }
  }
  const fromSettings = inputs.settings === true
  return {
    enabled: fromSettings,
    source: fromSettings ? 'settings' : undefined,
  }
}

let flagOverride: boolean | undefined
let memoized: ScreenReaderResolution | undefined

/**
 * Record the parsed `--ax-screen-reader` value. Called from the Commander
 * root action; passing `false` explicitly suppresses the argv fallback.
 */
export function setScreenReaderModeOverride(value: boolean): void {
  flagOverride = value
  memoized = undefined
}

export function resetScreenReaderModeForTesting(): void {
  flagOverride = undefined
  memoized = undefined
}

function readFlagChannel(): boolean | undefined {
  if (flagOverride !== undefined) return flagOverride
  // Pre-parse fallback: startup work that runs before the action handler
  // still needs the right answer.
  return process.argv.includes(SCREEN_READER_FLAG) ? true : undefined
}

function resolveOnce(): ScreenReaderResolution {
  if (memoized !== undefined) return memoized
  let settings: boolean | undefined
  try {
    settings = getInitialSettings().axScreenReader
  } catch {
    // Settings may be unreadable this early (or in a partially mocked test
    // process). Never let an accessibility lookup break startup.
    settings = undefined
  }
  memoized = resolveScreenReaderMode({
    flag: readFlagChannel(),
    env: process.env[SCREEN_READER_ENV_VAR],
    settings,
  })
  return memoized
}

/**
 * True when output should be flat text: no decorative borders, no
 * animations. This is the single predicate the render layer consumes.
 */
export function isScreenReaderMode(): boolean {
  return resolveOnce().enabled
}

/** Which channel enabled the mode, or `undefined` when it is off. */
export function screenReaderActivationSource(): ScreenReaderSource | undefined {
  return resolveOnce().source
}
