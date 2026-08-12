import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { getInitialSettings } from '../settings/settings.js'

/**
 * `:name` typeahead trigger. Two or more characters after the colon, so a bare
 * `:` or a smiley like `:-)` never opens the popup.
 */
export const EMOJI_PARTIAL_RE = /(^|\s):([a-z0-9_+-]{2,})$/

/** A finished `:name:` shortcode, replaced inline the moment it is closed. */
export const EMOJI_COMPLETE_RE = /(^|\s):([a-z0-9_+-]+):$/

/** Anything that looks like the start of a shortcode — used to warm the table. */
const EMOJI_PREFIX_RE = /(^|\s):[a-z0-9_+-]*:?$/

const MAX_EMOJI_SUGGESTIONS = 20

/** Internal on purpose — callers pass the value around, never the name. */
type EmojiIndex = {
  byName: Map<string, string>
  /** Insertion-ordered names, reused for every filter pass. */
  names: string[]
}

let loaded: EmojiIndex | null = null
let loading: Promise<EmojiIndex> | null = null

/**
 * Whether the `:emoji:` typeahead is on. Absent or `true` means enabled —
 * only an explicit `false` turns it off.
 */
export function isEmojiCompletionEnabled(): boolean {
  return getInitialSettings().emojiCompletionEnabled !== false
}

/** True when `text` (already sliced to the cursor) could start a shortcode. */
export function looksLikeEmojiShortcode(text: string): boolean {
  return EMOJI_PREFIX_RE.test(text)
}

/**
 * The shortcode table, or null when it has not been imported yet.
 *
 * Callers on the keystroke path use this rather than awaiting: the table is a
 * ~28KB chunk, and awaiting it mid-keystroke would race newer input. The first
 * `:` warms it via ensureEmojiIndex(); by the time the popup can trigger (two
 * characters later) it is resolved.
 */
export function getLoadedEmojiIndex(): EmojiIndex | null {
  return loaded
}

/** Import the shortcode table if needed. Safe to call on every keystroke. */
export function ensureEmojiIndex(): Promise<EmojiIndex> {
  if (loaded) return Promise.resolve(loaded)
  if (!loading) {
    loading = import('./emojiData.js').then(
      ({ EMOJI_ALIASES, EMOJI_SHORTCODES }) => {
        const byName = new Map<string, string>(Object.entries(EMOJI_SHORTCODES))
        for (const [alias, canonical] of Object.entries(EMOJI_ALIASES)) {
          if (byName.has(alias)) continue
          const char = EMOJI_SHORTCODES[canonical]
          if (char !== undefined) byName.set(alias, char)
        }
        loaded = { byName, names: [...byName.keys()] }
        return loaded
      },
    )
  }
  return loading
}

/** The character for an exact shortcode, or undefined when unknown. */
export function getEmoji(index: EmojiIndex, name: string): string | undefined {
  return index.byName.get(name)
}

/**
 * Shortcodes containing `prefix`, prefix matches first and shorter names
 * before longer ones, capped at 20 rows.
 */
export function getEmojiSuggestions(
  index: EmojiIndex,
  prefix: string,
): SuggestionItem[] {
  const needle = prefix.toLowerCase()
  const matches = index.names.filter(name => name.includes(needle))
  matches.sort((a, b) => {
    const aRank = a.startsWith(needle) ? 0 : 1
    const bRank = b.startsWith(needle) ? 0 : 1
    return aRank - bRank || a.length - b.length
  })
  return matches.slice(0, MAX_EMOJI_SUGGESTIONS).map(name => ({
    id: `emoji:${name}`,
    displayText: index.byName.get(name)!,
    description: `:${name}:`,
  }))
}

/**
 * Whether the edit that produced `value` was the user closing a shortcode,
 * rather than the cursor landing after a `:name:` that was already there.
 *
 * Reconstructs the insertion from the length delta: everything outside the
 * inserted span must still equal the previous value, and the inserted span
 * itself must end in the closing colon. Without this, moving the cursor past
 * old text would silently rewrite it.
 */
export function justClosedEmojiShortcode(
  value: string,
  previousValue: string | undefined,
  cursorOffset: number,
): boolean {
  if (previousValue === undefined) return false
  const insertedLength = value.length - previousValue.length
  const insertStart = cursorOffset - insertedLength
  if (insertedLength <= 0 || insertStart < 0) return false
  if (value.slice(0, insertStart) + value.slice(cursorOffset) !== previousValue)
    return false
  return /^[a-z0-9_+-]*:$/.test(value.slice(insertStart, cursorOffset))
}

/**
 * The inline `:name:` → emoji edit for the current keystroke, or null when this
 * keystroke isn't one (nothing was closed, or the shortcode is unknown).
 */
export function resolveInlineEmojiReplacement(
  index: EmojiIndex,
  value: string,
  cursorOffset: number,
  previousValue: string | undefined,
): { text: string; cursorOffset: number } | null {
  if (!justClosedEmojiShortcode(value, previousValue, cursorOffset)) return null
  const match = EMOJI_COMPLETE_RE.exec(value.slice(0, cursorOffset))
  const name = match?.[2]
  if (!match || name === undefined) return null
  const emoji = index.byName.get(name)
  if (emoji === undefined) return null
  const start = (match.index ?? 0) + (match[1]?.length ?? 0)
  return {
    text: value.slice(0, start) + emoji + value.slice(cursorOffset),
    cursorOffset: start + emoji.length,
  }
}
