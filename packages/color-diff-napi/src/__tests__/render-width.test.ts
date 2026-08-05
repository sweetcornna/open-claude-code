import { describe, expect, test } from 'bun:test'
import { structuredPatch } from 'diff'
import stripAnsi from 'strip-ansi'
import { stringWidth } from '@anthropic/ink/core/stringWidth.js'
import { ColorDiff } from '../index'

/**
 * Every changed (+/-) diff line must be padded to EXACTLY the requested
 * width. The renderer fills the line background to the column budget, so a
 * line measuring wider than `width` spills the red/green bar past the
 * terminal edge, and one measuring narrower leaves a ragged bar — the two
 * failure modes reported as "diff 渲染边界不一致".
 *
 * The bug this pins: width was measured with `str.length` whenever `Bun` was
 * undefined, and Node is the default runtime (bin.occ → dist/cli-node.js).
 * `str.length` counts a CJK char as 1 where the terminal allocates 2, so
 * `wrapText`'s pad-to-width overshot by one column per wide char. These
 * assertions fail under `str.length` and hold under a real width function,
 * which is what keeps this module and Ink measuring identically.
 */

const WIDTH_CASES = [30, 40, 55, 70, 100, 120]

function changedLineWidths(
  oldText: string,
  newText: string,
  width: number,
): number[] {
  const patch = structuredPatch(
    'a.txt',
    'a.txt',
    oldText,
    newText,
    undefined,
    undefined,
    { context: 1 },
  )
  const widths: number[] = []
  for (const hunk of patch.hunks) {
    const lines = new ColorDiff(hunk, null, 'a.txt', null).render(
      'dark',
      width,
      false,
    )
    expect(lines).not.toBeNull()
    for (const line of lines!) {
      // Changed lines are the ones the renderer pads; context lines are not.
      const plain = stripAnsi(line)
      if (/^\s*\d*\s*[+-]/.test(plain)) {
        widths.push(stringWidth(line))
      }
    }
  }
  return widths
}

const CASES: Array<{ name: string; old: string; next: string }> = [
  {
    name: 'CJK-heavy JSON value (the reported repro)',
    old: '  "keep": 1,\n  "scenarios": {"把 artifacts/margin-calc.json 的 price_scenarios 对象原样放这里": true},\n  "tail": 2,\n',
    next: '  "keep": 1,\n  "scenarios": {\n    "available": false,\n    "missing_reason": "无样本或核算字段不足时的机器原文；可用时为 null"\n  },\n  "tail": 2,\n',
  },
  {
    name: 'pure CJK line',
    old: '  x = 1\n  s = "中文中文中文中文中文中文中文中文"\n  y = 2\n',
    next: '  x = 1\n  s = "中文中文日本語日本語中文中文中文"\n  y = 2\n',
  },
  {
    name: 'ZWJ emoji',
    old: '  x = 1\n  s = "👨‍💻 before"\n  y = 2\n',
    next: '  x = 1\n  s = "👨‍💻 after with 中文 and more text"\n  y = 2\n',
  },
  {
    name: 'VS16 emoji',
    old: '  x = 1\n  s = "❤️ before"\n  y = 2\n',
    next: '  x = 1\n  s = "❤️ after ❤️ with extra"\n  y = 2\n',
  },
  {
    name: 'fullwidth punctuation',
    old: '  x = 1\n  s = "（全角）：、。！？"\n  y = 2\n',
    next: '  x = 1\n  s = "（全角）：、。！？；—…"\n  y = 2\n',
  },
  {
    name: 'pure ASCII (control: must not regress)',
    old: '  x = 1\n  s = "plain ascii before"\n  y = 2\n',
    next: '  x = 1\n  s = "plain ascii after, somewhat longer"\n  y = 2\n',
  },
]

describe('ColorDiff.render pads changed lines to exactly `width`', () => {
  for (const { name, old, next } of CASES) {
    for (const width of WIDTH_CASES) {
      test(`${name} @ width=${width}`, () => {
        const widths = changedLineWidths(old, next, width)
        expect(widths.length).toBeGreaterThan(0)
        for (const w of widths) {
          expect(w).toBe(width)
        }
      })
    }
  }

  // A wide char straddling the wrap boundary is where an off-by-one width
  // shows up first, so sweep every width across one wide-char period.
  test('wide chars at every wrap boundary offset', () => {
    const old = `  x = 1\n  s = "${'中'.repeat(20)}"\n  y = 2\n`
    const next = `  x = 1\n  s = "${'中'.repeat(8)}${'日'.repeat(8)}"\n  y = 2\n`
    for (let width = 20; width <= 60; width++) {
      for (const w of changedLineWidths(old, next, width)) {
        expect(w).toBe(width)
      }
    }
  })
})

describe('width measurement is runtime-agnostic', () => {
  // color-diff must not re-derive width locally. If it ever reintroduces a
  // `str.length` fallback, these diverge on the Node path and the diff
  // background misaligns again — see the file header.
  test('agrees with Ink on wide characters', () => {
    expect(stringWidth('中')).toBe(2)
    expect(stringWidth('中文abc')).toBe(7)
    expect(stringWidth('👨‍💻')).toBe(2)
    // The failing signature of the old fallback: length !== display width.
    expect(stringWidth('中文中文')).not.toBe('中文中文'.length)
  })
})
