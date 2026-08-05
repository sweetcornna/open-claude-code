import { describe, expect, test } from 'bun:test'
import {
  INITIAL_STATE,
  type KeyParseState,
  type ParsedInput,
  type ParsedKey,
  parseMultipleKeypresses,
} from '../parse-keypress.js'

function isKey(input: ParsedInput): input is ParsedKey {
  return input.kind === 'key'
}

function parseOne(input: string): ParsedKey {
  const state: KeyParseState = { ...INITIAL_STATE }
  const [keys] = parseMultipleKeypresses(state, input)

  expect(keys).toHaveLength(1)
  const key = keys[0]!
  expect(isKey(key)).toBe(true)

  return key as ParsedKey
}

describe('parseMultipleKeypresses ctrl+space', () => {
  test('parses a bare NUL byte as ctrl+space', () => {
    const key = parseOne('\x00')

    expect(key.name).toBe('space')
    expect(key.ctrl).toBe(true)
    expect(key.meta).toBe(false)
    expect(key.shift).toBe(false)
  })

  test('agrees with the kitty CSI-u encoding of ctrl+space', () => {
    const legacy = parseOne('\x00')
    const kitty = parseOne('\x1b[32;5u')

    expect(kitty.name).toBe('space')
    expect(kitty.ctrl).toBe(true)
    expect(kitty.name).toBe(legacy.name)
    expect(kitty.ctrl).toBe(legacy.ctrl)
  })
})

describe('parseMultipleKeypresses control characters', () => {
  test('still parses SOH as ctrl+a', () => {
    const key = parseOne('\x01')

    expect(key.name).toBe('a')
    expect(key.ctrl).toBe(true)
  })

  test('still parses SUB as ctrl+z', () => {
    const key = parseOne('\x1a')

    expect(key.name).toBe('z')
    expect(key.ctrl).toBe(true)
  })

  test('still parses US as ctrl+underscore', () => {
    const key = parseOne('\x1f')

    expect(key.name).toBe('_')
    expect(key.ctrl).toBe(true)
  })

  test('still parses a plain space without ctrl', () => {
    const key = parseOne(' ')

    expect(key.name).toBe('space')
    expect(key.ctrl).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Bracketed paste recovery.
//
// A terminal that opens a paste (ESC[200~) and never closes it used to latch
// the parser in IN_PASTE forever: every subsequent byte was appended to
// pasteBuffer instead of being parsed, so the keyboard went completely dead.
// App.tsx's PASTE_TIMEOUT was supposed to rescue this via a flush, but the
// flush only emitted when the buffer was non-empty, and App only armed the
// timer when the tokenizer had incomplete bytes (a paste has none). Both ends
// are fixed; these tests pin the parser half.
// ---------------------------------------------------------------------------

const PASTE_START_SEQ = '\x1b[200~'
const PASTE_END_SEQ = '\x1b[201~'

function feed(
  state: KeyParseState,
  input: string | null,
): [ParsedInput[], KeyParseState] {
  return parseMultipleKeypresses(state, input)
}

describe('parseMultipleKeypresses bracketed paste recovery', () => {
  test('a complete paste emits one paste key and returns to NORMAL', () => {
    const [keys, state] = feed(
      { ...INITIAL_STATE },
      `${PASTE_START_SEQ}hello${PASTE_END_SEQ}`,
    )

    expect(keys).toHaveLength(1)
    const key = keys[0]!
    expect(isKey(key)).toBe(true)
    expect((key as ParsedKey).isPasted).toBe(true)
    expect((key as ParsedKey).sequence).toBe('hello')
    expect(state.mode).toBe('NORMAL')
  })

  test('flush emits the buffered content when PASTE_END never arrives', () => {
    const [, opened] = feed({ ...INITIAL_STATE }, `${PASTE_START_SEQ}partial`)
    expect(opened.mode).toBe('IN_PASTE')

    const [keys, flushed] = feed(opened, null)

    expect(keys).toHaveLength(1)
    expect((keys[0] as ParsedKey).sequence).toBe('partial')
    expect(flushed.mode).toBe('NORMAL')
  })

  test('flush with an EMPTY paste buffer still leaves IN_PASTE', () => {
    // The wedge that stranded "Pasting text…": the terminal opened the paste
    // and sent nothing (mis-keyed image paste). Requiring a non-empty buffer
    // here meant the flush was a no-op and the mode never reset.
    const [, opened] = feed({ ...INITIAL_STATE }, PASTE_START_SEQ)
    expect(opened.mode).toBe('IN_PASTE')
    expect(opened.pasteBuffer).toBe('')

    const [keys, flushed] = feed(opened, null)

    expect(flushed.mode).toBe('NORMAL')
    // An empty paste key is meaningful downstream: on macOS it triggers the
    // clipboard-image check.
    expect(keys).toHaveLength(1)
    expect((keys[0] as ParsedKey).isPasted).toBe(true)
    expect((keys[0] as ParsedKey).sequence).toBe('')
  })

  test('an odd number of PASTE_START latches, and flush restores the keyboard', () => {
    // Content containing a bare ESC[200~ re-opens the paste, so the trailing
    // ESC[201~ closes the inner one and the outer stays open.
    const [, latched] = feed(
      { ...INITIAL_STATE },
      `${PASTE_START_SEQ}a${PASTE_START_SEQ}b${PASTE_END_SEQ}${PASTE_START_SEQ}c`,
    )
    expect(latched.mode).toBe('IN_PASTE')

    // While latched, ordinary keystrokes are swallowed into the paste buffer
    // rather than parsed — this is what made the prompt feel dead.
    const [swallowed, stillLatched] = feed(latched, 'x')
    expect(swallowed).toHaveLength(0)
    expect(stillLatched.mode).toBe('IN_PASTE')

    // The flush is the escape hatch.
    const [flushedKeys, recovered] = feed(stillLatched, null)
    expect(flushedKeys).toHaveLength(1)
    expect((flushedKeys[0] as ParsedKey).sequence).toBe('cx')
    expect(recovered.mode).toBe('NORMAL')

    // ...and normal parsing resumes.
    const [afterKeys] = feed(recovered, 'y')
    expect(afterKeys).toHaveLength(1)
    expect((afterKeys[0] as ParsedKey).name).toBe('y')
    expect((afterKeys[0] as ParsedKey).isPasted).toBeFalsy()
  })

  test('flushing outside paste mode is still a no-op', () => {
    const [keys, state] = feed({ ...INITIAL_STATE }, null)

    expect(keys).toHaveLength(0)
    expect(state.mode).toBe('NORMAL')
  })

  test('a stray PASTE_END with no matching start is dropped', () => {
    // It used to emit an empty paste key, which downstream reads as "Cmd+V of
    // an image" and kicks off a ~1.5s osascript clipboard probe for a key the
    // user never pressed.
    const [keys, state] = feed({ ...INITIAL_STATE }, PASTE_END_SEQ)

    expect(keys).toHaveLength(0)
    expect(state.mode).toBe('NORMAL')
  })

  test('an empty bracketed paste still emits (it means "check the clipboard")', () => {
    const [keys, state] = feed(
      { ...INITIAL_STATE },
      `${PASTE_START_SEQ}${PASTE_END_SEQ}`,
    )

    expect(keys).toHaveLength(1)
    expect((keys[0] as ParsedKey).isPasted).toBe(true)
    expect((keys[0] as ParsedKey).sequence).toBe('')
    expect(state.mode).toBe('NORMAL')
  })

  test('a doubled PASTE_END does not emit a phantom second paste', () => {
    const [keys, state] = feed(
      { ...INITIAL_STATE },
      `${PASTE_START_SEQ}hi${PASTE_END_SEQ}${PASTE_END_SEQ}`,
    )

    expect(keys).toHaveLength(1)
    expect((keys[0] as ParsedKey).sequence).toBe('hi')
    expect(state.mode).toBe('NORMAL')
  })
})
