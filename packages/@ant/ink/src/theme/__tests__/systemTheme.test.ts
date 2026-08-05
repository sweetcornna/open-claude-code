import { afterEach, describe, expect, test } from 'bun:test'
import {
  getSystemThemeName,
  resetCachedSystemThemeForTesting,
  setCachedSystemTheme,
  setSystemThemeMirror,
  themeFromOscColor,
} from '../systemTheme.js'

const originalColorFgBg = process.env.COLORFGBG

afterEach(() => {
  if (originalColorFgBg === undefined) delete process.env.COLORFGBG
  else process.env.COLORFGBG = originalColorFgBg
  resetCachedSystemThemeForTesting()
})

/**
 * `auto` classifies on the terminal's BACKGROUND COLOR, not the OS appearance
 * setting — a dark terminal on a light-mode OS must still resolve to 'dark',
 * because the palette has to be readable against what is actually behind it.
 */
describe('themeFromOscColor', () => {
  test('classifies real terminal backgrounds', () => {
    // rgb:R/G/B is what xterm, iTerm2, Terminal.app, Ghostty, kitty return.
    expect(themeFromOscColor('rgb:0000/0000/0000')).toBe('dark')
    expect(themeFromOscColor('rgb:ffff/ffff/ffff')).toBe('light')
    expect(themeFromOscColor('rgb:0000/2b2b/3636')).toBe('dark') // solarized dark
    expect(themeFromOscColor('rgb:fdfd/f6f6/e3e3')).toBe('light') // solarized light
  })

  test('accepts 1–4 digit components and the # forms', () => {
    // Components are scaled by digit count, so 'f' and 'ffff' are both max.
    expect(themeFromOscColor('rgb:f/f/f')).toBe('light')
    expect(themeFromOscColor('rgb:0/0/0')).toBe('dark')
    expect(themeFromOscColor('#ffffff')).toBe('light')
    expect(themeFromOscColor('#000000')).toBe('dark')
    expect(themeFromOscColor('#ffffffffffff')).toBe('light')
  })

  test('ignores a trailing alpha component', () => {
    expect(themeFromOscColor('rgba:ffff/ffff/ffff/ffff')).toBe('light')
  })

  test('returns undefined for junk so the caller keeps its current value', () => {
    // Guessing here would flip the entire palette on one malformed reply.
    expect(themeFromOscColor('')).toBeUndefined()
    expect(themeFromOscColor('not-a-color')).toBeUndefined()
    expect(themeFromOscColor('rgb:zz/zz/zz')).toBeUndefined()
  })

  test('uses perceptual luminance, not a naive channel average', () => {
    // Pure green is far brighter to the eye than pure blue; a mean of the
    // channels (85) would call both dark.
    expect(themeFromOscColor('rgb:0000/ffff/0000')).toBe('light')
    expect(themeFromOscColor('rgb:0000/0000/ffff')).toBe('dark')
  })
})

/**
 * $COLORFGBG is the synchronous seed used before the OSC 11 round-trip lands.
 * rxvt convention: bg 0–6 and 8 are dark; 7 (white) and 9–15 (bright) are
 * light. The tempting `bg >= 8 ? light : dark` split is wrong at BOTH ends.
 */
describe('getSystemThemeName seeds from $COLORFGBG', () => {
  const seed = (colorfgbg: string) => {
    process.env.COLORFGBG = colorfgbg
    resetCachedSystemThemeForTesting()
    return getSystemThemeName()
  }

  test('bg 7 (white) is light, not dark', () => {
    expect(seed('0;7')).toBe('light')
  })

  test('bg 8 (bright black) is dark, not light', () => {
    expect(seed('15;8')).toBe('dark')
  })

  test('classifies the remaining range', () => {
    expect(seed('15;0')).toBe('dark')
    expect(seed('15;6')).toBe('dark')
    expect(seed('0;9')).toBe('light')
    expect(seed('0;15')).toBe('light')
  })

  test('reads the LAST field (fg;other;bg form)', () => {
    expect(seed('0;default;15')).toBe('light')
  })

  test('falls back to dark when unset or unparseable', () => {
    delete process.env.COLORFGBG
    resetCachedSystemThemeForTesting()
    expect(getSystemThemeName()).toBe('dark')
    expect(seed('nonsense')).toBe('dark')
    expect(seed('0;99')).toBe('dark')
  })
})

describe('setCachedSystemTheme', () => {
  test('overrides the seed so later synchronous reads agree', () => {
    // resolveThemeSetting() reads this cache without awaiting the OSC probe;
    // it must reflect what the watcher last observed.
    process.env.COLORFGBG = '15;0'
    resetCachedSystemThemeForTesting()
    expect(getSystemThemeName()).toBe('dark')
    setCachedSystemTheme('light')
    expect(getSystemThemeName()).toBe('light')
  })

  /**
   * The host vendors its own copy of this module with its own module-level
   * cache, and host callers (LogoV2, Stats, FastIcon, QueryEngine) resolve
   * 'auto' through THAT copy. Without the mirror, Ink switches to light while
   * those stay on the dark seed — a visibly mixed palette.
   */
  test('mirrors every update to the host cache', () => {
    const seen: string[] = []
    setSystemThemeMirror(t => void seen.push(t))
    try {
      setCachedSystemTheme('light')
      setCachedSystemTheme('dark')
      expect(seen).toEqual(['light', 'dark'])
    } finally {
      setSystemThemeMirror(undefined)
    }
  })

  test('unregistering the mirror stops the notifications', () => {
    const seen: string[] = []
    setSystemThemeMirror(t => void seen.push(t))
    setSystemThemeMirror(undefined)
    setCachedSystemTheme('light')
    expect(seen).toEqual([])
  })
})
