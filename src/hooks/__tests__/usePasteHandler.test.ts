/**
 * Regression coverage for the "stuck on Pasting text…" wedge.
 *
 * Symptom: pasting an image with the wrong shortcut left the prompt showing
 * "Pasting text…" forever, with Enter swallowed (BaseTextInput drops
 * key.return while isPasting). Root cause was an uncaught rejection out of
 * `Promise.all(imagePaths.map(tryReadImageFromPath))` plus several branches
 * that returned without ever resetting `isPasting`.
 *
 * The invariant these tests pin down: EVERY exit path of completePaste ends
 * with setIsPasting(false), and the hook has a watchdog that unsticks the
 * prompt even when the async tail never settles at all.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'
import type { InputEvent, Key } from '@anthropic/ink'
import { debugMock } from '../../../tests/mocks/debug.js'
import { logMock } from '../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../tests/mocks/sharedModuleMock.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// Mock the LOW-level module (imagePaste), never the hook under test. The
// shared-module factory keeps the full export surface delegating to the real
// implementation, so `isImageFilePath` stays real and other suites that load
// imagePaste in the same process are unaffected.
const realImagePaste = await import('src/utils/terminal/imagePaste.js')
const imagePasteMock = makeSharedModuleMock(
  'src/utils/terminal/imagePaste.js',
  realImagePaste,
)
const imagePasteControls = imagePasteMock.setup()

// The clipboard fallbacks are macOS-only, so pin the platform rather than
// letting the suite behave differently on a Linux runner. Complete-surface
// mock: every other export still delegates to the real module.
const realPlatform = await import('src/utils/process/platform.js')
const platformControls = makeSharedModuleMock(
  'src/utils/process/platform.js',
  realPlatform,
).setup()

const { _test, usePasteHandler } = await import('../usePasteHandler.js')
const {
  completePaste,
  imageReadWatchdogBudget,
  splitPasteCandidates,
  withTimeout,
} = _test

const IMAGE_PATH = '/tmp/occ-paste-test/shot.png'

type ImageResult = Awaited<
  ReturnType<typeof realImagePaste.tryReadImageFromPath>
>

function fakeImage(path = IMAGE_PATH): NonNullable<ImageResult> {
  return {
    path,
    base64: 'AAAA',
    mediaType: 'image/png',
    dimensions: {
      originalWidth: 10,
      originalHeight: 10,
      displayWidth: 10,
      displayHeight: 10,
    },
  }
}

type Recorder = {
  pasted: string[]
  images: string[]
  pastingStates: boolean[]
  clipboardChecks: number
  deps: Parameters<typeof completePaste>[1]
}

function makeRecorder(
  overrides: Partial<Parameters<typeof completePaste>[1]> = {},
): Recorder {
  const rec: Recorder = {
    pasted: [],
    images: [],
    pastingStates: [],
    clipboardChecks: 0,
    deps: {} as Parameters<typeof completePaste>[1],
  }
  rec.deps = {
    onPaste: (text: string) => {
      rec.pasted.push(text)
    },
    onImagePaste: (base64: string) => {
      rec.images.push(base64)
    },
    checkClipboardForImage: () => {
      rec.clipboardChecks += 1
    },
    setIsPasting: (value: boolean) => {
      rec.pastingStates.push(value)
    },
    isMacOS: true,
    isCurrent: () => true,
    ...overrides,
  }
  return rec
}

afterEach(() => {
  imagePasteControls.reset()
})

describe('splitPasteCandidates', () => {
  test('splits newline- and space-separated absolute paths', () => {
    expect(splitPasteCandidates('/a/one.png /b/two.png\n/c/three.png')).toEqual(
      ['/a/one.png', '/b/two.png', '/c/three.png'],
    )
  })

  test('keeps escaped spaces inside a single path', () => {
    expect(splitPasteCandidates('/a/my\\ shot.png')).toEqual([
      '/a/my\\ shot.png',
    ])
  })
})

describe('withTimeout', () => {
  test('resolves to null instead of hanging forever', async () => {
    const never = new Promise<string>(() => {})
    expect(await withTimeout(never, 20)).toBeNull()
  })

  test('passes the value through when it settles in time', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 1000)).toBe('ok')
  })
})

describe('completePaste always releases the paste indicator', () => {
  test('image read rejection degrades to a plain text paste (root cause 1)', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: () =>
        Promise.reject(new Error('Image file is empty (0 bytes)')),
    })
    const rec = makeRecorder()

    await completePaste(IMAGE_PATH, rec.deps)

    // Before the fix this rejection escaped an uncaught `.then()`: no paste,
    // no reset, prompt wedged.
    expect(rec.pasted).toEqual([IMAGE_PATH])
    expect(rec.images).toEqual([])
    expect(rec.pastingStates).toEqual([false])
  })

  test('a single unreadable image does not drop the readable ones', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) =>
        Promise.resolve(path.includes('bad') ? null : fakeImage(path)),
    })
    const rec = makeRecorder()

    await completePaste('/tmp/good.png /tmp/bad.png', rec.deps)

    expect(rec.images).toEqual(['AAAA'])
    expect(rec.pastingStates).toEqual([false])
  })

  test('images plus trailing prose paste both parts', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) => Promise.resolve(fakeImage(path)),
    })
    const rec = makeRecorder()

    await completePaste(`${IMAGE_PATH}\nlook at this`, rec.deps)

    expect(rec.images).toEqual(['AAAA'])
    expect(rec.pasted).toEqual(['look at this'])
    expect(rec.pastingStates).toEqual([false])
  })

  test('vanished macOS screenshot hands the indicator to the clipboard read (root cause 4)', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: () => Promise.resolve(null),
    })
    const rec = makeRecorder()
    const screenshotPath =
      '/var/folders/x/TemporaryItems/screencaptureui.123/Screenshot 2026-08-04.png'

    await completePaste(screenshotPath, rec.deps)

    expect(rec.clipboardChecks).toBe(1)
    // Ownership passes to checkClipboardForImage so "Pasting text…" stays up
    // for the read the user is actually waiting on. It resets on every one of
    // its own paths, and the watchdog backs that up — see the live tests.
    expect(rec.pastingStates).toEqual([])
  })

  test('unreadable non-screenshot image paths paste as text', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: () => Promise.resolve(null),
    })
    const rec = makeRecorder()

    await completePaste(IMAGE_PATH, rec.deps)

    expect(rec.pasted).toEqual([IMAGE_PATH])
    expect(rec.pastingStates).toEqual([false])
  })

  test('empty macOS paste hands the indicator to the clipboard read (root cause 4)', async () => {
    const rec = makeRecorder()

    await completePaste('', rec.deps)

    expect(rec.clipboardChecks).toBe(1)
    expect(rec.pastingStates).toEqual([])
  })

  test('a cancelled paste delivers nothing once the reads land (P1)', async () => {
    // Held in an object: TS narrows a `let` assigned only inside a callback
    // down to `null` and then refuses the call.
    const gate: { release: (() => void) | null } = { release: null }
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) =>
        new Promise(resolve => {
          gate.release = () => resolve(fakeImage(path))
        }),
    })
    let cancelled = false
    const rec = makeRecorder({ isCurrent: () => !cancelled })

    const done = completePaste(IMAGE_PATH, rec.deps)
    // ...user hits Esc while the read is still outstanding.
    cancelled = true
    gate.release?.()
    await done

    expect(rec.images).toEqual([])
    expect(rec.pasted).toEqual([])
    // abortPaste already reset the indicator; touching it again could unstick
    // a NEW paste the user started after cancelling.
    expect(rec.pastingStates).toEqual([])
  })

  test('a cancelled paste does not fall back to text when the read rejects (P1)', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: () => Promise.reject(new Error('boom')),
    })
    const rec = makeRecorder({ isCurrent: () => false })

    await completePaste(IMAGE_PATH, rec.deps)

    expect(rec.pasted).toEqual([])
    expect(rec.pastingStates).toEqual([])
  })

  test('image reads report start and per-image progress for the watchdog (P2)', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) => Promise.resolve(fakeImage(path)),
    })
    const starts: number[] = []
    const progress: number[] = []
    const rec = makeRecorder({
      onImageReadStart: count => {
        starts.push(count)
      },
      onImageReadProgress: pending => {
        progress.push(pending)
      },
    })

    await completePaste('/tmp/a.png /tmp/b.png /tmp/c.png', rec.deps)

    expect(starts).toEqual([3])
    // Counts down so the watchdog budget can shrink with the remaining work.
    expect(progress).toEqual([2, 1, 0])
  })
})

describe('imageReadWatchdogBudget', () => {
  test('grows with the batch size and stays above the default watchdog', () => {
    expect(imageReadWatchdogBudget(1)).toBeGreaterThan(
      _test.PASTE_WATCHDOG_TIMEOUT_MS,
    )
    expect(imageReadWatchdogBudget(3)).toBeGreaterThan(
      imageReadWatchdogBudget(1),
    )
  })

  test('is capped so a wedge is still eventually released', () => {
    expect(imageReadWatchdogBudget(1000)).toBeLessThanOrEqual(60_000)
  })

  test('plain text paste resets', async () => {
    const rec = makeRecorder()

    await completePaste('hello world', rec.deps)

    expect(rec.pasted).toEqual(['hello world'])
    expect(rec.pastingStates).toEqual([false])
  })

  test('no onImagePaste handler still resets on an image path', async () => {
    const rec = makeRecorder({ onImagePaste: undefined })

    await completePaste(IMAGE_PATH, rec.deps)

    expect(rec.pasted).toEqual([IMAGE_PATH])
    expect(rec.pastingStates).toEqual([false])
  })
})

// ---------------------------------------------------------------------------
// Live-hook tests. usePasteHandler is stateful (timers + refs + React state),
// so these mount it in a real Ink tree and drive wrappedOnInput directly.
// ---------------------------------------------------------------------------

const { wrappedRender: render } = await import('@anthropic/ink')

function makeKey(overrides: Partial<Key> = {}): Key {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    pageDown: false,
    pageUp: false,
    return: false,
    escape: false,
    ctrl: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    meta: false,
    ...overrides,
  } as unknown as Key
}

function pasteEvent(isPasted: boolean): InputEvent {
  return { keypress: { isPasted } } as unknown as InputEvent
}

type Harness = {
  send: (input: string, key?: Partial<Key>, isPasted?: boolean) => void
  isPasting: () => boolean
  pasted: string[]
  images: string[]
  typed: string[]
  unmount: () => void
}

async function mountHook(): Promise<Harness> {
  const pasted: string[] = []
  const images: string[] = []
  const typed: string[] = []
  let handler: ReturnType<typeof usePasteHandler> | null = null

  function Probe(): React.ReactNode {
    handler = usePasteHandler({
      onPaste: text => {
        pasted.push(text)
      },
      onInput: input => {
        typed.push(input)
      },
      onImagePaste: base64 => {
        images.push(base64)
      },
    })
    return null
  }

  const stdout = new PassThrough()
  stdout.resume()
  const stdin = new PassThrough()
  const instance = await render(React.createElement(Probe), {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream,
    patchConsole: false,
    exitOnCtrlC: false,
  })
  await tick(0)

  return {
    send: (input, key = {}, isPasted = true) => {
      handler?.wrappedOnInput(input, makeKey(key), pasteEvent(isPasted))
    },
    isPasting: () => handler?.isPasting ?? false,
    pasted,
    images,
    typed,
    unmount: () => {
      instance.unmount()
      instance.cleanup()
    },
  }
}

function tick(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('usePasteHandler live behaviour', () => {
  let harness: Harness | null = null

  beforeEach(() => {
    harness = null
  })

  afterEach(() => {
    harness?.unmount()
    imagePasteControls.reset()
    platformControls.reset()
  })

  test('the clipboard fallback keeps the indicator lit, then clears it', async () => {
    // Restored deliberately: the first cut cleared isPasting before the read
    // even started, so the user got no feedback during the ~1.5s osascript
    // round trip. The watchdog (widened for the read) is what makes keeping
    // it lit safe now.
    platformControls.set({ getPlatform: () => 'macos' })
    const gate: { release: (() => void) | null } = { release: null }
    imagePasteControls.set({
      getImageFromClipboard: () =>
        new Promise(resolve => {
          gate.release = () =>
            resolve({ base64: 'CLIP', mediaType: 'image/png' })
        }),
    })
    harness = await mountHook()

    // Empty bracketed paste == Cmd+V of an image on macOS.
    harness.send('')
    await tick(120) // past the 50ms clipboard debounce
    expect(harness.isPasting()).toBe(true)

    gate.release?.()
    await tick(50)
    expect(harness.images).toEqual(['CLIP'])
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('Esc inside the debounce window cancels the queued clipboard read', async () => {
    // The queued read has not captured a generation yet, so bumping the
    // generation alone does not stop it: 30ms later the debounce would fire,
    // read the NEW generation, pass every guard, re-light the indicator and
    // inject the image the user just cancelled.
    platformControls.set({ getPlatform: () => 'macos' })
    let reads = 0
    imagePasteControls.set({
      getImageFromClipboard: () => {
        reads += 1
        return Promise.resolve({ base64: 'CLIP', mediaType: 'image/png' })
      },
    })
    harness = await mountHook()

    harness.send('') // empty bracketed paste == Cmd+V of an image
    // ...and Esc lands well inside the 50ms clipboard debounce.
    harness.send('\x1b', { escape: true }, false)
    await tick(0)
    expect(harness.isPasting()).toBe(false)

    await tick(250)
    expect(reads).toBe(0)
    expect(harness.images).toEqual([])
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('a stale image read does not blink off a newer paste (indicator epoch)', async () => {
    // The watchdog releases paste #1 without cancelling it (a late result is
    // still welcome — that is the P2 semantic). If paste #1's continuation
    // could still clear the indicator, it would blink paste #2's
    // "Pasting text…" off underneath the user. Only the epoch separates these:
    // the generation is deliberately untouched by the watchdog.
    //
    // This has to use the image path. The clipboard path is bounded by
    // withTimeout (3s) below its own watchdog (4.5s), so its continuation can
    // never actually outlive its indicator; tryReadImageFromPath has no such
    // bound.
    const gate: { release: (() => void) | null } = { release: null }
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) =>
        path.includes('slow')
          ? new Promise(resolve => {
              gate.release = () => resolve(fakeImage(path))
            })
          : new Promise(() => {}),
    })
    harness = await mountHook()

    harness.send('/tmp/slow.png')
    await tick(200)
    expect(harness.isPasting()).toBe(true)

    // Watchdog releases paste #1; its read is still outstanding.
    await tick(_test.IMAGE_READ_WATCHDOG_BASE_MS + 400)
    expect(harness.isPasting()).toBe(false)

    // The user starts a fresh paste, which lights the indicator again.
    harness.send('/tmp/hang.png')
    await tick(200)
    expect(harness.isPasting()).toBe(true)

    // Paste #1 finally lands. It may still DELIVER (generation untouched)...
    gate.release?.()
    await tick(120)
    expect(harness.images).toEqual(['AAAA'])
    // ...but it no longer owns the indicator, so paste #2 stays lit.
    expect(harness.isPasting()).toBe(true)
  }, 30000)

  test('a hung clipboard read is released by its own watchdog budget', async () => {
    platformControls.set({ getPlatform: () => 'macos' })
    imagePasteControls.set({
      getImageFromClipboard: () => new Promise(() => {}),
    })
    harness = await mountHook()

    harness.send('')
    await tick(120)
    expect(harness.isPasting()).toBe(true)

    await tick(_test.CLIPBOARD_WATCHDOG_TIMEOUT_MS + 400)
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('a rejected image read no longer wedges the prompt (root cause 1)', async () => {
    imagePasteControls.set({
      tryReadImageFromPath: () => Promise.reject(new Error('boom')),
    })
    harness = await mountHook()

    harness.send(IMAGE_PATH)
    await tick(0)
    expect(harness.isPasting()).toBe(true)

    await tick(250)
    expect(harness.isPasting()).toBe(false)
    expect(harness.pasted).toEqual([IMAGE_PATH])
  })

  test('Esc aborts a paste in flight and drops the buffered chunks (root cause 7)', async () => {
    harness = await mountHook()

    harness.send('some pasted text')
    await tick(0)
    expect(harness.isPasting()).toBe(true)

    harness.send('\x1b', { escape: true }, false)
    await tick(0)
    expect(harness.isPasting()).toBe(false)

    // The buffered chunk must be discarded, not delivered late.
    await tick(250)
    expect(harness.pasted).toEqual([])
    expect(harness.isPasting()).toBe(false)
  })

  test('the watchdog unsticks a paste whose async tail never settles (root cause 2)', async () => {
    imagePasteControls.set({
      // Never settles — stands in for a hung osascript / TCC prompt.
      tryReadImageFromPath: () => new Promise(() => {}),
    })
    harness = await mountHook()

    harness.send(IMAGE_PATH)
    await tick(200)
    expect(harness.isPasting()).toBe(true)

    await tick(_test.IMAGE_READ_WATCHDOG_BASE_MS + 500)
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('a slow image read outlives the default watchdog and still lands (P2)', async () => {
    // Sharp cold start plus a large decode routinely exceeds the 2.5s default.
    // Killing the paste at that point would attach the image to the user's
    // NEXT message, so the image branch widens the budget.
    const readMs = _test.PASTE_WATCHDOG_TIMEOUT_MS + 800
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) =>
        new Promise(resolve => {
          setTimeout(() => resolve(fakeImage(path)), readMs)
        }),
    })
    harness = await mountHook()

    harness.send(IMAGE_PATH)

    // Past the default budget, still working — pre-fix this had been reset.
    await tick(_test.PASTE_WATCHDOG_TIMEOUT_MS + 400)
    expect(harness.isPasting()).toBe(true)
    expect(harness.images).toEqual([])

    await tick(900)
    expect(harness.images).toEqual(['AAAA'])
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('Esc after the read starts discards the late image (P1)', async () => {
    // The gap the first round missed: Esc inside the 100ms coalescing window
    // was covered, but Esc AFTER finishPaste had already kicked off the reads
    // left the async tail holding onImagePaste. The image then appeared in the
    // prompt seconds after the user had cancelled.
    imagePasteControls.set({
      tryReadImageFromPath: (path: string) =>
        new Promise(resolve => {
          setTimeout(() => resolve(fakeImage(path)), 500)
        }),
    })
    harness = await mountHook()

    harness.send(IMAGE_PATH)
    // Well past PASTE_COMPLETION_TIMEOUT_MS: the read is genuinely in flight.
    await tick(_test.PASTE_COMPLETION_TIMEOUT_MS + 120)
    expect(harness.isPasting()).toBe(true)

    harness.send('\x1b', { escape: true }, false)
    await tick(0)
    expect(harness.isPasting()).toBe(false)

    // Let the read finish. Nothing may reach the prompt.
    await tick(700)
    expect(harness.images).toEqual([])
    expect(harness.pasted).toEqual([])
    expect(harness.isPasting()).toBe(false)
  }, 20000)

  test('Esc with no paste in flight is passed through to onInput (P4)', async () => {
    harness = await mountHook()

    harness.send('\x1b', { escape: true }, false)
    await tick(0)

    expect(harness.typed).toEqual(['\x1b'])
    expect(harness.isPasting()).toBe(false)
  })

  test('Esc after a paste completes is passed through to onInput (P4)', async () => {
    harness = await mountHook()

    harness.send('hello world')
    await tick(250)
    expect(harness.isPasting()).toBe(false)

    harness.send('\x1b', { escape: true }, false)
    await tick(0)

    expect(harness.typed).toEqual(['\x1b'])
  })

  test('a normal text paste still lands', async () => {
    harness = await mountHook()

    harness.send('hello ')
    harness.send('world')
    await tick(250)

    expect(harness.pasted).toEqual(['hello world'])
    expect(harness.isPasting()).toBe(false)
  })
})
