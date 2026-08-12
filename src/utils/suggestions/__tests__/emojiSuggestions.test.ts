import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import type { SettingsJson } from '../../settings/types.js'
import {
  EMOJI_COMPLETE_RE,
  EMOJI_PARTIAL_RE,
  ensureEmojiIndex,
  getEmoji,
  getEmojiSuggestions,
  getLoadedEmojiIndex,
  isEmojiCompletionEnabled,
  justClosedEmojiShortcode,
  looksLikeEmojiShortcode,
  resolveInlineEmojiReplacement,
} from '../emojiSuggestions.js'

const settingsMock = setupSettingsMock()

let settings: SettingsJson = {}

beforeAll(() => {
  settingsMock.set({ getInitialSettings: () => settings })
})

afterAll(() => {
  settingsMock.reset()
})

beforeEach(() => {
  settings = {}
})

describe('isEmojiCompletionEnabled', () => {
  test('defaults to on', () => {
    expect(isEmojiCompletionEnabled()).toBe(true)
    settings = { emojiCompletionEnabled: true }
    expect(isEmojiCompletionEnabled()).toBe(true)
  })

  test('only an explicit false turns it off', () => {
    settings = { emojiCompletionEnabled: false }
    expect(isEmojiCompletionEnabled()).toBe(false)
  })
})

describe('triggers', () => {
  test('the popup needs at least two characters after the colon', () => {
    expect(EMOJI_PARTIAL_RE.test('see :ta')).toBe(true)
    expect(EMOJI_PARTIAL_RE.test(':ta')).toBe(true)
    expect(EMOJI_PARTIAL_RE.test(':t')).toBe(false)
    expect(EMOJI_PARTIAL_RE.test(':')).toBe(false)
  })

  test('does not fire mid-word, so http:// and ratios are safe', () => {
    expect(EMOJI_PARTIAL_RE.test('https://example')).toBe(false)
    expect(EMOJI_PARTIAL_RE.test('scale 3:20')).toBe(false)
    expect(EMOJI_COMPLETE_RE.test('a:b:')).toBe(false)
  })

  test('the inline replacement needs a closed shortcode', () => {
    expect(EMOJI_COMPLETE_RE.test('ship it :tada:')).toBe(true)
    expect(EMOJI_COMPLETE_RE.test('ship it :tada')).toBe(false)
  })

  test('looksLikeEmojiShortcode warms on the first colon', () => {
    expect(looksLikeEmojiShortcode('see :')).toBe(true)
    expect(looksLikeEmojiShortcode('see :ta')).toBe(true)
    expect(looksLikeEmojiShortcode('see :tada:')).toBe(true)
    expect(looksLikeEmojiShortcode('see tada')).toBe(false)
  })
})

describe('justClosedEmojiShortcode', () => {
  test('true when the closing colon was just typed', () => {
    expect(justClosedEmojiShortcode('hi :tada:', 'hi :tada', 9)).toBe(true)
  })

  test('true when the whole word was completed at once', () => {
    expect(justClosedEmojiShortcode('hi :tada:', 'hi :', 9)).toBe(true)
  })

  test('false when nothing was inserted (cursor movement only)', () => {
    expect(justClosedEmojiShortcode('hi :tada:', 'hi :tada:', 9)).toBe(false)
    expect(justClosedEmojiShortcode('hi :tada:', undefined, 9)).toBe(false)
  })

  test('false when the insertion does not end in a colon', () => {
    expect(justClosedEmojiShortcode('hi :tada: x', 'hi :tada:', 11)).toBe(false)
  })

  test('false when the surrounding text also changed', () => {
    expect(justClosedEmojiShortcode('yo :tada:', 'hi :tada', 9)).toBe(false)
  })
})

describe('emoji index', () => {
  test('is not loaded until asked for, then stays loaded', async () => {
    const index = await ensureEmojiIndex()
    expect(getLoadedEmojiIndex()).toBe(index)
    expect(index.names.length).toBeGreaterThan(500)
  })

  test('resolves exact shortcodes and aliases', async () => {
    const index = await ensureEmojiIndex()
    expect(getEmoji(index, 'tada')).toBe('🎉')
    expect(getEmoji(index, '+1')).toBe('👍')
    expect(getEmoji(index, 'thumbsup')).toBe(getEmoji(index, '+1'))
    expect(getEmoji(index, 'definitely_not_an_emoji')).toBeUndefined()
  })

  test('suggestions are prefix-first, then shortest, capped at 20', async () => {
    const index = await ensureEmojiIndex()
    const items = getEmojiSuggestions(index, 'smi')
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(20)
    expect(items[0]!.id).toBe('emoji:smile')
    expect(items[0]!.displayText).toBe('😄')
    expect(items[0]!.description).toBe(':smile:')

    const names = items.map(i => i.description!.slice(1, -1))
    const firstNonPrefix = names.findIndex(n => !n.startsWith('smi'))
    if (firstNonPrefix !== -1) {
      expect(names.slice(firstNonPrefix).every(n => !n.startsWith('smi'))).toBe(
        true,
      )
    }
  })

  test('matches substrings, not just prefixes', async () => {
    const index = await ensureEmojiIndex()
    const names = getEmojiSuggestions(index, 'rocket').map(i => i.description)
    expect(names).toContain(':rocket:')
  })

  test('unknown prefixes produce nothing', async () => {
    const index = await ensureEmojiIndex()
    expect(getEmojiSuggestions(index, 'zzzzqqq')).toEqual([])
  })
})

describe('resolveInlineEmojiReplacement', () => {
  test('swaps the shortcode in place and puts the cursor after it', async () => {
    const index = await ensureEmojiIndex()
    expect(
      resolveInlineEmojiReplacement(
        index,
        'ship it :tada:',
        14,
        'ship it :tada',
      ),
    ).toEqual({ text: 'ship it 🎉', cursorOffset: 10 })
  })

  test('works at the very start of the input', async () => {
    const index = await ensureEmojiIndex()
    expect(resolveInlineEmojiReplacement(index, ':tada:', 6, ':tada')).toEqual({
      text: '🎉',
      cursorOffset: 2,
    })
  })

  test('keeps text after the cursor', async () => {
    const index = await ensureEmojiIndex()
    expect(
      resolveInlineEmojiReplacement(index, 'a :tada: b', 8, 'a :tada b'),
    ).toEqual({ text: 'a 🎉 b', cursorOffset: 4 })
  })

  test('leaves unknown shortcodes alone', async () => {
    const index = await ensureEmojiIndex()
    expect(
      resolveInlineEmojiReplacement(index, 'hi :nope_x:', 11, 'hi :nope_x'),
    ).toBeNull()
  })

  test('does nothing when the colon was not just typed', async () => {
    const index = await ensureEmojiIndex()
    expect(
      resolveInlineEmojiReplacement(
        index,
        'ship it :tada:',
        14,
        'ship it :tada:',
      ),
    ).toBeNull()
  })
})
