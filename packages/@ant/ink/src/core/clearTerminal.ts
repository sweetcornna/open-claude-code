/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js'

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f')

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env.TERM_PROGRAM === 'mintty') {
    return true
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env.MSYSTEM) {
    return true
  }
  return false
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env.TERM_PROGRAM === 'vscode' &&
    process.env.TERM_PROGRAM_VERSION
  ) {
    return true
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true
  }

  return false
}

/**
 * Returns the ANSI escape sequence to clear the terminal including scrollback.
 * Automatically detects terminal capabilities.
 *
 * DESTRUCTIVE: `CSI 3J` discards the terminal's scrollback buffer — everything
 * the user scrolled back to read is gone, and it cannot be recovered. Use this
 * ONLY for an explicit user-initiated clear. For internal repaints use
 * {@link getRepaintSequence}.
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
    } else {
      // Legacy Windows console - can't clear scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME
}

/**
 * Sequence for a self-healing full repaint: erase the visible screen and home
 * the cursor, leaving scrollback intact.
 *
 * Every full reset the renderer emits (resize, offscreen-row change, legacy
 * conhost self-heal) is an internal redraw the user did not ask for. Those
 * previously reused getClearTerminalSequence(), so each one also fired
 * `CSI 3J` and destroyed the scrollback buffer — the user's whole session
 * history vanished and the viewport snapped to the top, mid-session, with no
 * action on their part. That is the "右键回到终端顶部" report: something
 * provokes a repaint (a context menu stealing focus, a terminal reporting a
 * spurious size change) and the repaint takes the history with it.
 *
 * A repaint only needs the visible screen cleared: the diff that follows
 * rewrites every visible cell, and scrollback is not ours to discard.
 */
export function getRepaintSequence(): string {
  if (process.platform === 'win32' && !isModernWindowsTerminal()) {
    return ERASE_SCREEN + CURSOR_HOME_WINDOWS
  }
  return ERASE_SCREEN + CURSOR_HOME
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence()
