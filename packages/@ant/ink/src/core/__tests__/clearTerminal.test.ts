import { describe, expect, test } from 'bun:test'
import {
  getClearTerminalSequence,
  getRepaintSequence,
} from '../clearTerminal.js'

const ERASE_SCROLLBACK = '\x1b[3J'
const ERASE_SCREEN = '\x1b[2J'
const CURSOR_HOME = '\x1b[H'
const CURSOR_HOME_WIN = '\x1b[0f'

/**
 * `CSI 3J` discards the terminal's scrollback buffer. That is irreversible —
 * everything the user scrolled back to read is gone, and the viewport snaps to
 * the top.
 *
 * The renderer emits a full reset for its own reasons (resize, an offscreen row
 * changing, legacy-conhost self-heal), none of which the user asked for. Those
 * paths previously reused getClearTerminalSequence(), so an ordinary internal
 * repaint destroyed the session history mid-session — the "右键回到终端顶部"
 * report: something provokes a repaint and the repaint takes the scrollback
 * with it.
 */
describe('getRepaintSequence', () => {
  test('never discards scrollback', () => {
    expect(getRepaintSequence()).not.toContain(ERASE_SCROLLBACK)
  })

  test('still erases the visible screen and homes the cursor', () => {
    // The diff that follows rewrites every visible cell, but it assumes it is
    // painting onto a cleared screen from a known cursor position.
    const seq = getRepaintSequence()
    expect(seq).toContain(ERASE_SCREEN)
    // CSI H (or the legacy Windows CSI 0 f) — both home the cursor.
    expect(seq.includes(CURSOR_HOME) || seq.includes(CURSOR_HOME_WIN)).toBe(
      true,
    )
  })
})

describe('getClearTerminalSequence', () => {
  test('does discard scrollback — it is the explicit user-clear path', () => {
    // Kept distinct on purpose: an explicit clear SHOULD wipe history. The bug
    // was reusing this for repaints, not the sequence itself.
    if (process.platform === 'win32') return
    expect(getClearTerminalSequence()).toContain(ERASE_SCROLLBACK)
  })

  test('is strictly more destructive than the repaint sequence', () => {
    if (process.platform === 'win32') return
    expect(getClearTerminalSequence()).not.toBe(getRepaintSequence())
  })
})
