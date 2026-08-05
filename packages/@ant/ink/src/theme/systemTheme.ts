/**
 * Terminal dark/light mode detection.
 *
 * Detection is based on the terminal's actual background color (queried via
 * OSC 11) rather than the OS appearance setting — a dark terminal on a
 * light-mode OS should still resolve to 'dark'.
 *
 * Vendored from src/utils/terminal/systemTheme.ts for package independence.
 * Keep the two in sync: they must classify identically or the palette the
 * renderer picks disagrees with the one the business layer reports.
 */

export type SystemTheme = 'dark' | 'light'

let cachedSystemTheme: SystemTheme | undefined

/**
 * Read $COLORFGBG for a synchronous initial guess before the OSC 11
 * round-trip completes. Format is `fg;bg` (or `fg;other;bg`) where values are
 * ANSI color indices.
 *
 * rxvt convention: bg 0–6 and 8 are dark; bg 7 (white) and 9–15 (bright) are
 * light. The obvious `bg >= 8 ? light : dark` split gets BOTH ends wrong —
 * it calls 7 (white, the classic light terminal) dark and 8 (bright black)
 * light. Only set by some terminals (rxvt-family, Konsole, iTerm2 with the
 * option enabled), so this is a best-effort hint that OSC 11 then corrects.
 */
function detectFromColorFgBg(): SystemTheme | undefined {
  const colorFgBg = process.env.COLORFGBG
  if (!colorFgBg) return undefined
  const parts = colorFgBg.split(';')
  if (parts.length < 2) return undefined
  const bg = parts[parts.length - 1]
  if (bg === undefined || bg === '') return undefined
  const bgNum = Number(bg)
  if (!Number.isInteger(bgNum) || bgNum < 0 || bgNum > 15) return undefined
  return bgNum <= 6 || bgNum === 8 ? 'dark' : 'light'
}

/**
 * Get the current terminal theme. Cached after first detection; the watcher
 * updates the cache on live changes.
 */
export function getSystemThemeName(): SystemTheme {
  if (cachedSystemTheme === undefined) {
    cachedSystemTheme = detectFromColorFgBg() ?? 'dark'
  }
  return cachedSystemTheme
}

export function setCachedSystemTheme(theme: SystemTheme): void {
  cachedSystemTheme = theme
}

/** Test seam — lets a suite start from a known-empty cache. */
export function resetCachedSystemThemeForTesting(): void {
  cachedSystemTheme = undefined
}

/**
 * Parse an OSC 10/11 color response into a theme.
 *
 * Accepts the XParseColor formats terminals actually return:
 * - `rgb:R/G/B`, each component 1–4 hex digits (xterm, iTerm2, Terminal.app,
 *   Ghostty, kitty, Alacritty, …). An `rgba:` variant with a trailing alpha
 *   component is accepted and the alpha ignored.
 * - `#RRGGBB` / `#RRRRGGGGBBBB` (rare, but cheap to accept).
 *
 * Returns undefined for unrecognized formats so callers can keep their
 * previous value rather than guessing.
 */
export function themeFromOscColor(data: string): SystemTheme | undefined {
  const rgb = parseOscRgb(data)
  if (!rgb) return undefined
  // ITU-R BT.709 relative luminance. Midpoint split: > 0.5 is light.
  const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
  return luminance > 0.5 ? 'light' : 'dark'
}

type Rgb = { r: number; g: number; b: number }

function parseOscRgb(data: string): Rgb | undefined {
  const rgbMatch =
    /^rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(data)
  if (rgbMatch) {
    return {
      r: hexComponent(rgbMatch[1]!),
      g: hexComponent(rgbMatch[2]!),
      b: hexComponent(rgbMatch[3]!),
    }
  }
  const hashMatch = /^#([0-9a-f]+)$/i.exec(data)
  if (hashMatch && hashMatch[1]!.length % 3 === 0) {
    const hex = hashMatch[1]!
    const n = hex.length / 3
    return {
      r: hexComponent(hex.slice(0, n)),
      g: hexComponent(hex.slice(n, 2 * n)),
      b: hexComponent(hex.slice(2 * n)),
    }
  }
  return undefined
}

/** Normalize a 1–4 digit hex component to [0, 1]. */
function hexComponent(hex: string): number {
  const max = 16 ** hex.length - 1
  return parseInt(hex, 16) / max
}
