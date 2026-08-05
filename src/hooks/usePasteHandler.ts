import { basename } from 'path'
import React from 'react'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import { logError } from 'src/utils/telemetry/log.js'
import { useDebounceCallback } from 'usehooks-ts'
import type { InputEvent, Key } from '@anthropic/ink'
import {
  getImageFromClipboard,
  isImageFilePath,
  PASTE_THRESHOLD,
  tryReadImageFromPath,
} from '../utils/terminal/imagePaste.js'
import type { ImageDimensions } from '../utils/terminal/imageResizer.js'
import { getPlatform } from '../utils/process/platform.js'

const CLIPBOARD_CHECK_DEBOUNCE_MS = 50
const PASTE_COMPLETION_TIMEOUT_MS = 100

/**
 * Hard ceiling on how long `isPasting` may stay true with no further paste
 * activity. While it is true BaseTextInput swallows Enter, so any paste
 * pipeline that never settles — a rejected image read, a hung `osascript`,
 * a branch that returns without resetting — leaves the prompt permanently
 * dead behind a "Pasting text…" indicator. This watchdog is the last line of
 * defence and covers every such path at once. It is re-armed on every paste
 * chunk, so a long streaming paste never trips it.
 *
 * The watchdog is a UI safety net, NOT a cancellation: it deliberately does
 * not invalidate the in-flight generation, so a slow-but-successful read
 * still delivers its image. Only an explicit Esc discards results.
 */
const PASTE_WATCHDOG_TIMEOUT_MS = 2500

/**
 * `getImageFromClipboard` shells out to osascript / xclip / powershell. On
 * macOS a first-run TCC (screen-recording / automation) prompt can leave that
 * child hanging indefinitely; the promise then never settles and the
 * `.finally` that resets `isPasting` never runs.
 */
const CLIPBOARD_READ_TIMEOUT_MS = 3000

/**
 * Watchdog budget while a clipboard read is outstanding. Must outlast
 * CLIPBOARD_READ_TIMEOUT_MS, otherwise the indicator blinks off underneath a
 * read that is still going to succeed (osascript alone routinely takes ~1.5s).
 */
const CLIPBOARD_WATCHDOG_TIMEOUT_MS = CLIPBOARD_READ_TIMEOUT_MS + 1500

/**
 * Watchdog budget while images are being read off disk. This is the one
 * genuinely slow stage of a paste: Sharp's cold start plus a multi-megabyte
 * decode routinely exceeds the 2.5s default, and a premature reset there is
 * worse than a stuck indicator — the image lands on the user's NEXT message.
 * The budget grows with the batch size and is renewed as each image lands.
 *
 * Firing this is not catastrophic the way it would be with cancel semantics:
 * releasePaste(false) leaves the generation untouched, so a read that finishes
 * afterwards still delivers its image. The budget only decides how long the
 * user stays blocked before we let them type again.
 */
const IMAGE_READ_WATCHDOG_BASE_MS = 6_000
const IMAGE_READ_WATCHDOG_PER_IMAGE_MS = 4_000
const IMAGE_READ_WATCHDOG_MAX_MS = 45_000

function imageReadWatchdogBudget(pendingImages: number): number {
  const extra =
    Math.max(0, pendingImages - 1) * IMAGE_READ_WATCHDOG_PER_IMAGE_MS
  return Math.min(
    IMAGE_READ_WATCHDOG_BASE_MS + extra,
    IMAGE_READ_WATCHDOG_MAX_MS,
  )
}

type OnImagePaste = (
  base64Image: string,
  mediaType?: string,
  filename?: string,
  dimensions?: ImageDimensions,
  sourcePath?: string,
) => void

type PasteHandlerProps = {
  onPaste?: (text: string) => void
  onInput: (input: string, key: Key) => void
  onImagePaste?: OnImagePaste
}

/**
 * Races `promise` against a timer, resolving to `null` if the timer wins.
 * Never rejects on timeout — callers treat `null` as "no clipboard image".
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<null>(resolve => {
        timer = setTimeout(() => resolve(null), ms)
      }),
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

/**
 * Split pasted text into path candidates.
 *
 * When dragging multiple images they may arrive as:
 * 1. Newline-separated paths (common in some terminals)
 * 2. Space-separated paths (common when dragging from Finder)
 *
 * For space-separated paths we split on spaces that precede absolute paths:
 * - Unix: space followed by `/` (e.g. `/Users/...`)
 * - Windows: space followed by drive letter and `:\` (e.g. `C:\Users\...`)
 *
 * This works because spaces within paths are escaped (e.g. `file\ name.png`).
 */
function splitPasteCandidates(text: string): string[] {
  return text
    .split(/ (?=\/|[A-Za-z]:\\)/)
    .flatMap(part => part.split('\n'))
    .filter(line => line.trim())
}

type PasteCompletionDeps = {
  onPaste?: (text: string) => void
  onImagePaste?: OnImagePaste
  checkClipboardForImage: () => void
  setIsPasting: (value: boolean) => void
  isMacOS: boolean
  /**
   * False once the user has cancelled (Esc) or the hook unmounted. Checked
   * after every await: without it, an image whose read finishes seconds after
   * the cancel still gets injected into whatever the user typed next.
   */
  isCurrent: () => boolean
  /** Called with the batch size just before image reads begin. */
  onImageReadStart?: (imageCount: number) => void
  /** Heartbeat: called with the still-pending count as each image lands. */
  onImageReadProgress?: (pendingImages: number) => void
}

/**
 * Turn the accumulated paste buffer into image attachments and/or text.
 *
 * Two invariants, both of which the original code broke:
 * 1. Every exit path either resets `isPasting` itself or hands ownership to
 *    `checkClipboardForImage`, which resets it on all of its own paths.
 * 2. Nothing is delivered to `onPaste` / `onImagePaste` after `isCurrent()`
 *    goes false.
 */
async function completePaste(
  pastedText: string,
  deps: PasteCompletionDeps,
): Promise<void> {
  const {
    onPaste,
    onImagePaste,
    checkClipboardForImage,
    setIsPasting,
    isMacOS,
    isCurrent,
    onImageReadStart,
    onImageReadProgress,
  } = deps

  const lines = splitPasteCandidates(pastedText)
  const imagePaths = lines.filter(line => isImageFilePath(line))

  if (onImagePaste && imagePaths.length > 0) {
    const isTempScreenshot =
      /\/TemporaryItems\/.*screencaptureui.*\/Screenshot/i.test(pastedText)

    onImageReadStart?.(imagePaths.length)
    let pending = imagePaths.length

    let results: Awaited<ReturnType<typeof tryReadImageFromPath>>[]
    try {
      results = await Promise.all(
        imagePaths.map(async imagePath => {
          const image = await tryReadImageFromPath(imagePath)
          pending -= 1
          onImageReadProgress?.(pending)
          return image
        }),
      )
    } catch (error) {
      // Defence in depth: tryReadImageFromPath now swallows its own decode /
      // resize failures, but a rejection here used to escape an uncaught
      // `.then()` and strand the prompt on "Pasting text…" forever with Enter
      // swallowed. Degrade to a plain text paste rather than losing the input.
      logError(error as Error)
      if (!isCurrent()) {
        return
      }
      onPaste?.(pastedText)
      setIsPasting(false)
      return
    }

    // The user may have hit Esc while the reads were in flight. Their intent
    // is "cancel", so everything below has to be dropped — abortPaste has
    // already reset the indicator.
    if (!isCurrent()) {
      return
    }

    const validImages = results.filter((r): r is NonNullable<typeof r> => {
      return r !== null
    })

    if (validImages.length > 0) {
      // Successfully read at least one image
      for (const imageData of validImages) {
        onImagePaste(
          imageData.base64,
          imageData.mediaType,
          basename(imageData.path),
          imageData.dimensions,
          imageData.path,
        )
      }
      // If some paths weren't images, paste them as text
      const nonImageLines = lines.filter(line => !isImageFilePath(line))
      if (nonImageLines.length > 0 && onPaste) {
        onPaste(nonImageLines.join('\n'))
      }
      setIsPasting(false)
      return
    }

    if (isTempScreenshot && isMacOS) {
      // Temporary screenshot file already gone — fall back to the clipboard.
      // Ownership of the indicator passes to checkClipboardForImage, which
      // resets it on every one of its own paths (hit, miss, error, timeout,
      // early return) and widens the watchdog for the read's duration. Keeping
      // it lit is the point: the clipboard read is the slow part the user is
      // actually waiting on.
      checkClipboardForImage()
      return
    }

    onPaste?.(pastedText)
    setIsPasting(false)
    return
  }

  // If paste is empty (common when trying to paste images with Cmd+V),
  // check if clipboard has an image (macOS only). As above, the clipboard
  // read owns the indicator from here.
  if (isMacOS && onImagePaste && pastedText.length === 0) {
    checkClipboardForImage()
    return
  }

  // Handle regular paste
  onPaste?.(pastedText)
  setIsPasting(false)
}

export function usePasteHandler({
  onPaste,
  onInput,
  onImagePaste,
}: PasteHandlerProps): {
  wrappedOnInput: (input: string, key: Key, event: InputEvent) => void
  isPasting: boolean
} {
  const [isPasting, setIsPasting] = React.useState(false)
  const isMountedRef = React.useRef(true)
  // Mirrors the pending-paste timer but updated synchronously. When paste + a
  // keystroke arrive in the same stdin chunk, both wrappedOnInput calls run
  // in the same discreteUpdates batch before React commits — a state-based
  // check would read a stale value and take the onInput path. If that key is
  // Enter, it submits the old input and the paste is lost.
  const pastePendingRef = React.useRef(false)
  // Synchronous mirror of `isPasting`, for the same batching reason.
  const isPastingRef = React.useRef(false)
  // Chunks live in a ref rather than in state. The completion timer used to
  // read them from inside a setState updater and fire onPaste/onImagePaste
  // from there — an impure updater that React is free to re-run (it does under
  // StrictMode), double-pasting and leaking timers. Keeping them out of state
  // also drops one re-render per paste chunk.
  const chunksRef = React.useRef<string[]>([])
  const completionTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  const watchdogTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(
    null,
  )
  // Two independent tokens, because "may I deliver this content?" and "do I
  // still own the indicator?" have different lifetimes and mixing them was a
  // bug:
  //
  // generation — DELIVERY rights. Bumped only by an explicit cancel (Esc) or
  //   unmount. A late read whose generation is stale must not reach onPaste /
  //   onImagePaste. The watchdog deliberately does NOT bump it: releasing a
  //   blocked UI is not the user saying "throw my image away".
  // indicatorEpoch — INDICATOR ownership. Bumped on every false -> true
  //   transition, i.e. once per lit indicator. An async continuation may only
  //   clear the indicator it lit itself; otherwise the watchdog releases paste
  //   #1, the user starts paste #2, and paste #1's `.finally` blinks #2's
  //   "Pasting text…" off underneath them.
  const generationRef = React.useRef(0)
  const indicatorEpochRef = React.useRef(0)
  // Cancels a clipboard read that is queued in the debounce but has not
  // started. Held in a ref to break a definition cycle: releasePaste needs it,
  // but the debounced callback reaches releasePaste through setPastingState ->
  // armWatchdog. Assigned once the debounced callback exists, below.
  const cancelQueuedClipboardReadRef = React.useRef<(() => void) | null>(null)

  const isMacOS = React.useMemo(() => getPlatform() === 'macos', [])

  const clearWatchdog = React.useCallback(() => {
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current)
      watchdogTimerRef.current = null
    }
  }, [])

  const clearPasteTimers = React.useCallback(() => {
    if (completionTimerRef.current) {
      clearTimeout(completionTimerRef.current)
      completionTimerRef.current = null
    }
    clearWatchdog()
  }, [clearWatchdog])

  /**
   * Drop everything buffered and unstick the prompt.
   *
   * `discardInFlight` distinguishes the two callers, which mean different
   * things: an explicit Esc is a cancellation (late results must be thrown
   * away), while the watchdog is only a safety net for a UI that has been
   * blocked too long (a late result is still welcome).
   */
  const releasePaste = React.useCallback(
    (discardInFlight: boolean) => {
      if (discardInFlight) {
        generationRef.current += 1
        // A read still sitting in the 50ms debounce has not captured a
        // generation yet, so bumping alone does not stop it: when it fires it
        // would read the NEW generation, pass every guard, re-light the
        // indicator and inject the image the user just cancelled.
        cancelQueuedClipboardReadRef.current?.()
      }
      clearPasteTimers()
      pastePendingRef.current = false
      isPastingRef.current = false
      chunksRef.current = []
      setIsPasting(false)
    },
    [clearPasteTimers],
  )

  const abortPaste = React.useCallback(() => {
    releasePaste(true)
  }, [releasePaste])

  const armWatchdog = React.useCallback(
    (budgetMs: number) => {
      clearWatchdog()
      watchdogTimerRef.current = setTimeout(() => {
        watchdogTimerRef.current = null
        if (!isMountedRef.current) {
          return
        }
        logForDebugging(
          `Paste watchdog fired: releasing paste state after ${budgetMs}ms`,
          { level: 'warn' },
        )
        releasePaste(false)
      }, budgetMs)
    },
    [clearWatchdog, releasePaste],
  )

  /**
   * Single funnel for the paste indicator. Arming/clearing the watchdog here
   * (rather than in an effect keyed on `isPasting`) keeps it alive across the
   * whole async tail of a paste, which is exactly the window that can hang,
   * and lets slow stages ask for a wider budget.
   */
  const setPastingState = React.useCallback(
    (value: boolean, budgetMs: number = PASTE_WATCHDOG_TIMEOUT_MS) => {
      if (value && !isPastingRef.current) {
        // A fresh lighting of the indicator: whoever lit it now owns clearing
        // it, and every older continuation loses that right.
        indicatorEpochRef.current += 1
      }
      isPastingRef.current = value
      if (value) {
        armWatchdog(budgetMs)
      } else {
        clearWatchdog()
      }
      setIsPasting(value)
    },
    [armWatchdog, clearWatchdog],
  )

  React.useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      // Unmount is a cancellation: nothing in flight has anywhere to land.
      generationRef.current += 1
      cancelQueuedClipboardReadRef.current?.()
      clearPasteTimers()
    }
  }, [clearPasteTimers])

  const checkClipboardForImageImpl = React.useCallback(() => {
    if (!onImagePaste || !isMountedRef.current) {
      // Even the early return has to clear the indicator: reaching here with
      // isPasting still true left "Pasting text…" up with no pending work.
      if (isMountedRef.current) {
        setPastingState(false)
      }
      return
    }

    const generation = generationRef.current
    // Keep the indicator lit for the duration of the read, with a budget that
    // outlasts the subprocess timeout. Read the epoch AFTER lighting it, so we
    // capture the epoch this read is responsible for.
    setPastingState(true, CLIPBOARD_WATCHDOG_TIMEOUT_MS)
    const epoch = indicatorEpochRef.current

    void withTimeout(getImageFromClipboard(), CLIPBOARD_READ_TIMEOUT_MS)
      .then(imageData => {
        if (
          imageData &&
          isMountedRef.current &&
          generationRef.current === generation
        ) {
          onImagePaste(
            imageData.base64,
            imageData.mediaType,
            undefined, // no filename for clipboard images
            imageData.dimensions,
          )
        }
      })
      .catch(error => {
        if (isMountedRef.current) {
          logError(error as Error)
        }
      })
      .finally(() => {
        // Only clear the indicator we lit ourselves. If the watchdog released
        // this paste and the user has since started another one, that paste
        // owns the indicator now and clearing it here would blink it off.
        if (isMountedRef.current && indicatorEpochRef.current === epoch) {
          setPastingState(false)
        }
      })
  }, [onImagePaste, setPastingState])

  const checkClipboardForImage = useDebounceCallback(
    checkClipboardForImageImpl,
    CLIPBOARD_CHECK_DEBOUNCE_MS,
  )
  // Idempotent ref write; `cancel` is stable across renders.
  cancelQueuedClipboardReadRef.current = checkClipboardForImage.cancel

  const finishPaste = React.useCallback(() => {
    completionTimerRef.current = null
    pastePendingRef.current = false

    // Join chunks and filter out orphaned focus sequences.
    // These can appear when focus events split during paste.
    const pastedText = chunksRef.current
      .join('')
      .replace(/\[I$/, '')
      .replace(/\[O$/, '')
    chunksRef.current = []

    const generation = generationRef.current
    const epoch = indicatorEpochRef.current
    const isCurrent = (): boolean => generationRef.current === generation
    // Clearing the indicator is only ours to do while we still own the epoch
    // we started with — see the indicatorEpochRef comment. Lighting it is
    // always allowed; only the async release needs guarding.
    const setIsPasting = (value: boolean): void => {
      if (!value && indicatorEpochRef.current !== epoch) {
        return
      }
      setPastingState(value)
    }

    void completePaste(pastedText, {
      onPaste,
      onImagePaste,
      checkClipboardForImage,
      setIsPasting,
      isMacOS,
      isCurrent,
      // Same ownership rule as the setter: a read that has outlived its own
      // indicator must not go on extending someone else's watchdog budget.
      onImageReadStart: imageCount => {
        if (indicatorEpochRef.current !== epoch) {
          return
        }
        armWatchdog(imageReadWatchdogBudget(imageCount))
      },
      onImageReadProgress: pending => {
        if (indicatorEpochRef.current !== epoch) {
          return
        }
        armWatchdog(imageReadWatchdogBudget(Math.max(1, pending)))
      },
    }).catch(error => {
      logError(error as Error)
      if (isCurrent()) {
        setIsPasting(false)
      }
    })
  }, [
    armWatchdog,
    checkClipboardForImage,
    isMacOS,
    onImagePaste,
    onPaste,
    setPastingState,
  ])

  // Paste detection is now done via the InputEvent's keypress.isPasted flag,
  // which is set by the keypress parser when it detects bracketed paste mode.
  // This avoids the race condition caused by having multiple listeners on stdin.
  // Previously, we had a stdin.on('data') listener here which competed with
  // the 'readable' listener in App.tsx, causing dropped characters.

  const wrappedOnInput = (input: string, key: Key, event: InputEvent): void => {
    // Detect paste from the parsed keypress event.
    // The keypress parser sets isPasted=true for content within bracketed paste.
    const isFromPaste = event.keypress.isPasted

    // Escape hatch. While a paste is in flight every keystroke is swallowed —
    // buffered into `chunks` here, or dropped by BaseTextInput's isPasting
    // guard (Enter). Esc must always be able to hand the prompt back, so it is
    // checked before anything else can consume it. When no paste is pending
    // this falls through and Esc behaves normally.
    if (
      !isFromPaste &&
      key.escape &&
      (pastePendingRef.current || isPastingRef.current)
    ) {
      abortPaste()
      return
    }

    // If this is pasted content, set isPasting state for UI feedback
    if (isFromPaste) {
      setPastingState(true)
    }

    // Handle large pastes (>PASTE_THRESHOLD chars)
    // Usually we get one or two input characters at a time. If we
    // get more than the threshold, the user has probably pasted.
    // Unfortunately node batches long pastes, so it's possible
    // that we would see e.g. 1024 characters and then just a few
    // more in the next frame that belong with the original paste.
    // This batching number is not consistent.

    // Handle potential image filenames (even if they're shorter than paste
    // threshold). See splitPasteCandidates for the splitting rules.
    const hasImageFilePath = splitPasteCandidates(input).some(line =>
      isImageFilePath(line.trim()),
    )

    // Handle empty paste (clipboard image on macOS)
    // When the user pastes an image with Cmd+V, the terminal sends an empty
    // bracketed paste sequence. The keypress parser emits this as isPasted=true
    // with empty input. The clipboard read owns the indicator from here.
    if (isFromPaste && input.length === 0 && isMacOS && onImagePaste) {
      checkClipboardForImage()
      return
    }

    // Check if we should handle as paste (from bracketed paste, large input, or continuation)
    const shouldHandleAsPaste =
      onPaste &&
      (input.length > PASTE_THRESHOLD ||
        pastePendingRef.current ||
        hasImageFilePath ||
        isFromPaste ||
        (input.length >= 3 &&
          !key.return &&
          !key.tab &&
          !key.escape &&
          !key.upArrow &&
          !key.downArrow &&
          !key.leftArrow &&
          !key.rightArrow))

    if (shouldHandleAsPaste) {
      pastePendingRef.current = true
      // Keep the watchdog alive for the duration of a long streaming paste;
      // it only starts counting down once the chunks stop arriving.
      if (watchdogTimerRef.current) {
        armWatchdog(PASTE_WATCHDOG_TIMEOUT_MS)
      }
      chunksRef.current = [...chunksRef.current, input]
      if (completionTimerRef.current) {
        clearTimeout(completionTimerRef.current)
      }
      completionTimerRef.current = setTimeout(
        finishPaste,
        PASTE_COMPLETION_TIMEOUT_MS,
      )
      return
    }
    onInput(input, key)
    if (input.length > 10) {
      // Ensure that setIsPasting is turned off on any other multicharacter
      // input, because the stdin buffer may chunk at arbitrary points and split
      // the closing escape sequence if the input length is too long for the
      // stdin buffer.
      setPastingState(false)
    }
  }

  return {
    wrappedOnInput,
    isPasting,
  }
}

export const _test = {
  completePaste,
  imageReadWatchdogBudget,
  splitPasteCandidates,
  withTimeout,
  CLIPBOARD_WATCHDOG_TIMEOUT_MS,
  IMAGE_READ_WATCHDOG_BASE_MS,
  PASTE_COMPLETION_TIMEOUT_MS,
  PASTE_WATCHDOG_TIMEOUT_MS,
}
