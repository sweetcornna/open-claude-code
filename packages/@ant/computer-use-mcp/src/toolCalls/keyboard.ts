import { isSystemKeyCombo } from '../keyBlocklist.js'
import type {
  ComputerUseHostAdapter,
  ComputerUseOverrides,
  CuSubGates,
} from '../types.js'
import { errorResult, okText, requireString } from './core.js'
import type { CuCallToolResult } from './core.js'
import { runInputActionGates } from './inputGates.js'
import { sleep } from './timing.js'

// ---------------------------------------------------------------------------
// Grapheme iteration — §6 item 7, ported from the Vercept acquisition
// ---------------------------------------------------------------------------

export const INTER_GRAPHEME_SLEEP_MS = 8
// §6 item 4 — 125 Hz USB polling

export function segmentGraphemes(text: string): string[] {
  try {
    // Node 18+ has Intl.Segmenter; the try is defence against a stripped-
    // -down runtime (falls back to code points).
    const Segmenter = (
      Intl as typeof Intl & {
        Segmenter?: new (
          locale?: string,
          options?: { granularity: 'grapheme' | 'word' | 'sentence' },
        ) => { segment: (s: string) => Iterable<{ segment: string }> }
      }
    ).Segmenter
    if (typeof Segmenter === 'function') {
      const seg = new Segmenter(undefined, { granularity: 'grapheme' })
      return Array.from(seg.segment(text), s => s.segment)
    }
  } catch {
    // fall through
  }
  // Code-point iteration. Keeps surrogate pairs together but splits ZWJ.
  return Array.from(text)
}

/**
 * Split a chord string like "ctrl+shift" into individual key names.
 * Same parsing as `key` tool / executor.key / keyBlocklist.normalizeKeySequence.
 */
export function parseKeyChord(text: string): string[] {
  return text
    .split('+')
    .map(s => s.trim())
    .filter(Boolean)
}

export async function handleType(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const text = requireString(args, 'text')
  if (text instanceof Error) return errorResult(text.message, 'bad_args')

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    'keyboard',
  )
  if (gate) return gate

  // §6 item 3 — clipboard-paste fast path for multi-line. Sub-gated AND
  // requires clipboardWrite grant. The save/restore + read-back-verify
  // lives in the EXECUTOR (task #5), not here. Here we just route.
  const viaClipboard =
    text.includes('\n') &&
    overrides.grantFlags.clipboardWrite &&
    subGates.clipboardPasteMultiline

  if (viaClipboard) {
    await adapter.executor.type(text, { viaClipboard: true })
    return okText('Typed (via clipboard).')
  }

  // §6 item 7 — grapheme-cluster iteration. Prevents ZWJ emoji → �.
  // §6 item 4 — 8ms between graphemes (125 Hz USB polling). Battle-tested:
  // sleep BEFORE each keystroke, not after.
  //
  // \n, \r, \t MUST route through executor.key(), not type(). Two reasons:
  //   1. enigo.text("\n") on macOS posts a stale CGEvent with virtualKey=0
  //      after stripping the newline — virtualKey 0 is the 'a' key, so a
  //      ghost 'a' gets typed. Upstream bug in enigo 0.6.1 fast_text().
  //   2. Unicode text-insertion of '\n' is not a Return key press. URL bars
  //      and terminals ignore it; the model's intent (submit/execute) is lost.
  // CRLF (\r\n) is one grapheme cluster (UAX #29 GB3), so check for it too.
  const graphemes = segmentGraphemes(text)
  for (const [i, g] of graphemes.entries()) {
    // Same abort check as handleComputerBatch. At 8ms/grapheme a 50-char
    // type() runs ~400ms; this is where an in-flight batch actually
    // spends its time.
    if (overrides.isAborted?.()) {
      return errorResult(
        `Typing aborted after ${i} of ${graphemes.length} graphemes (user interrupt).`,
      )
    }
    await sleep(INTER_GRAPHEME_SLEEP_MS)
    if (g === '\n' || g === '\r' || g === '\r\n') {
      await adapter.executor.key('return')
    } else if (g === '\t') {
      await adapter.executor.key('tab')
    } else {
      await adapter.executor.type(g, { viaClipboard: false })
    }
  }
  return okText(`Typed ${graphemes.length} grapheme(s).`)
}

export async function handleKey(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const keySequence = requireString(args, 'text')
  if (keySequence instanceof Error)
    return errorResult('text is required', 'bad_args')

  // Cap 100, error strings match.
  let repeat: number | undefined
  if (args.repeat !== undefined) {
    if (
      typeof args.repeat !== 'number' ||
      !Number.isInteger(args.repeat) ||
      args.repeat < 1
    ) {
      return errorResult('repeat must be a positive integer', 'bad_args')
    }
    if (args.repeat > 100) {
      return errorResult('repeat exceeds maximum of 100', 'bad_args')
    }
    repeat = args.repeat
  }

  // §2 — blocklist check BEFORE gates. A blocked combo with an ungranted
  // app frontmost should return the blocklist error, not the frontmost
  // error — the model's fix is to request the flag, not change focus.
  if (
    isSystemKeyCombo(keySequence, adapter.executor.capabilities.platform) &&
    !overrides.grantFlags.systemKeyCombos
  ) {
    return errorResult(
      `"${keySequence}" is a system-level shortcut. Request the \`systemKeyCombos\` grant via request_access to use it.`,
      'grant_flag_required',
    )
  }

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    'keyboard',
  )
  if (gate) return gate

  await adapter.executor.key(keySequence, repeat)
  return okText('Key pressed.')
}

export async function handleVirtualKeyboard(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
): Promise<CuCallToolResult> {
  if (!adapter.executor.virtualKeyboard) {
    return errorResult(
      'virtual_keyboard is only available on Windows with a bound window.',
      'feature_unavailable',
    )
  }
  const action = requireString(args, 'action')
  if (action instanceof Error) return errorResult(action.message, 'bad_args')
  const text = requireString(args, 'text')
  if (text instanceof Error) return errorResult(text.message, 'bad_args')

  const validActions = new Set(['type', 'combo', 'press', 'release', 'hold'])
  if (!validActions.has(action)) {
    return errorResult(
      `Invalid action "${action}". Valid: ${[...validActions].join(', ')}`,
      'bad_args',
    )
  }

  const duration = typeof args.duration === 'number' ? args.duration : undefined
  const repeat = typeof args.repeat === 'number' ? args.repeat : undefined

  const ok = await adapter.executor.virtualKeyboard({
    action: action as any,
    text,
    duration,
    repeat,
  })

  if (!ok) {
    return errorResult(
      'No window is currently bound. Use open_application or bind_window first.',
      'bad_args',
    )
  }

  const desc: Record<string, string> = {
    type: `Typed "${text.length > 40 ? text.slice(0, 40) + '...' : text}"`,
    combo: `Sent ${text}`,
    press: `Pressed ${text} (holding)`,
    release: `Released ${text}`,
    hold: `Held ${text} for ${duration ?? 1}s`,
  }

  return okText(`${desc[action]}${repeat && repeat > 1 ? ` ×${repeat}` : ''}`)
}

/**
 * Presses each key in the
 * chord, sleeps duration seconds, releases in reverse. Same duration bounds
 * as wait. Keyboard action → frontmost gate applies; same systemKeyCombos
 * blocklist check as key.
 */
export async function handleHoldKey(
  adapter: ComputerUseHostAdapter,
  args: Record<string, unknown>,
  overrides: ComputerUseOverrides,
  subGates: CuSubGates,
): Promise<CuCallToolResult> {
  const text = requireString(args, 'text')
  if (text instanceof Error) return errorResult(text.message, 'bad_args')

  const duration = args.duration
  if (typeof duration !== 'number' || !Number.isFinite(duration)) {
    return errorResult('duration must be a number', 'bad_args')
  }
  if (duration < 0) {
    return errorResult('duration must be non-negative', 'bad_args')
  }
  if (duration > 100) {
    return errorResult(
      'duration is too long. Duration is in seconds.',
      'bad_args',
    )
  }

  // Blocklist check BEFORE gates — same reasoning as handleKey. Holding
  // cmd+q is just as dangerous as tapping it.
  if (
    isSystemKeyCombo(text, adapter.executor.capabilities.platform) &&
    !overrides.grantFlags.systemKeyCombos
  ) {
    return errorResult(
      `"${text}" is a system-level shortcut. Request the \`systemKeyCombos\` grant via request_access to use it.`,
      'grant_flag_required',
    )
  }

  const gate = await runInputActionGates(
    adapter,
    overrides,
    subGates,
    'keyboard',
  )
  if (gate) return gate

  const keyNames = parseKeyChord(text)
  await adapter.executor.holdKey(keyNames, duration * 1000)
  return okText('Key held.')
}
