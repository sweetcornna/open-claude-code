import { describe, expect, test } from 'bun:test'
import { stringWidthJavaScript } from '../stringWidth.js'

/**
 * The renderer keeps a virtual screen and emits only RELATIVE cursor moves, so
 * any disagreement between this width model and what the terminal actually
 * advances is permanent for the rest of the frame: text shifts sideways, a row
 * overflows into an autowrap, and the row model desyncs from the screen.
 *
 * Two implementations exist — Bun.stringWidth when running under Bun, and the
 * JavaScript fallback everywhere else. Node is the default runtime (`bin.occ`
 * is `dist/cli-node.js`), so the fallback is the one most users get, and it is
 * the one `bun test` never selects. These tests call it directly.
 */
describe('stringWidthJavaScript', () => {
  test('agrees with Bun.stringWidth', () => {
    // The invariant that matters: one binary must not lay out text differently
    // from the other. Sampled across the ranges where the two used to diverge.
    const samples = [
      '⚠',
      '✔',
      '✳',
      '☑',
      '✂',
      '★',
      '☀',
      '✈',
      '⚡',
      '❤',
      '⚠️', // with VS16 — emoji presentation, genuinely 2 columns
      '❤️',
      '😀',
      '👍🏽', // skin-tone modifier
      '👨‍👩‍👧', // ZWJ family
      '#️⃣', // keycap
      '你好',
      'abc',
      'a⚠b',
      '中英mixed混排',
      '…',
    ]
    for (const sample of samples) {
      expect({ sample, width: stringWidthJavaScript(sample) }).toEqual({
        sample,
        width: Bun.stringWidth(sample, { ambiguousIsNarrow: true }),
      })
    }
  })

  test('text-presentation symbols measure one column', () => {
    // Emoji_Presentation=No: without U+FE0F these render text-style. Charging
    // 2 is what shifted every following character one column left.
    for (const symbol of ['⚠', '✔', '✳', '☑', '✂']) {
      expect(stringWidthJavaScript(symbol)).toBe(1)
    }
  })

  test('the same symbols measure two columns once VS16 requests emoji style', () => {
    for (const symbol of ['⚠️', '✔️', '☑️']) {
      expect(stringWidthJavaScript(symbol)).toBe(2)
    }
  })

  test('genuine emoji still measure two columns', () => {
    for (const emoji of ['😀', '🎉', '🚀']) {
      expect(stringWidthJavaScript(emoji)).toBe(2)
    }
  })

  test('CJK measures two columns per character', () => {
    expect(stringWidthJavaScript('你好')).toBe(4)
    expect(stringWidthJavaScript('本')).toBe(2)
  })

  test('ASCII measures one column per character', () => {
    expect(stringWidthJavaScript('hello')).toBe(5)
  })
})
