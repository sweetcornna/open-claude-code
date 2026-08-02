import chalk from 'chalk'
import { supportsHyperlinks } from '@anthropic/ink'

// OSC 8 hyperlink escape sequences
// Format: \e]8;;URL\e\\TEXT\e]8;;\e\\
// Using \x07 (BEL) as terminator which is more widely supported
export const OSC8_START = '\x1b]8;;'
export const OSC8_END = '\x07'

type HyperlinkOptions = {
  supportsHyperlinks?: boolean
}

/**
 * Single decision point for "may we emit OSC 8 hyperlinks?".
 *
 * FORCE_HYPERLINK is honored FIRST: the upstream `supports-hyperlinks`
 * library gets this right, but the @anthropic/ink wrapper consults a
 * TERM_PROGRAM allowlist (iTerm2/kitty/ghostty/alacritty/Hyper) AFTER the
 * library returns false — so FORCE_HYPERLINK=0 was silently overridden on
 * exactly the terminals that render hyperlinks (official 2.1.217 parity
 * fix). Every CLI-side OSC 8 emitter must route through this function.
 *
 * Known blind spot: ink's own <Link> component (ClickableImageRef) calls the
 * wrapper internally and is not covered here; fixing that requires patching
 * the vendored ink package.
 */
export function terminalSupportsHyperlinks(): boolean {
  const force = process.env.FORCE_HYPERLINK
  if (force !== undefined && force.trim() !== '') {
    return force !== '0' && force.toLowerCase() !== 'false'
  }
  return supportsHyperlinks()
}

/**
 * Create a clickable hyperlink using OSC 8 escape sequences.
 * Falls back to plain text if the terminal doesn't support hyperlinks.
 *
 * @param url - The URL to link to
 * @param content - Optional content to display as the link text (only when hyperlinks are supported).
 *                  If provided and hyperlinks are supported, this text is shown as a clickable link.
 *                  If hyperlinks are not supported, content is ignored and only the URL is shown.
 * @param options - Optional overrides for testing (supportsHyperlinks)
 */
export function createHyperlink(
  url: string,
  content?: string,
  options?: HyperlinkOptions,
): string {
  const hasSupport = options?.supportsHyperlinks ?? terminalSupportsHyperlinks()
  if (!hasSupport) {
    return url
  }

  // Apply basic ANSI blue color - wrap-ansi preserves this across line breaks
  // RGB colors (like theme colors) are NOT preserved by wrap-ansi with OSC 8
  const displayText = content ?? url
  const coloredText = chalk.blue(displayText)
  return `${OSC8_START}${url}${OSC8_END}${coloredText}${OSC8_START}${OSC8_END}`
}
