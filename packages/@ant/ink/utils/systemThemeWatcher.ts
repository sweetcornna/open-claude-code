import type React from 'react'
import { oscColor, type TerminalQuerier } from '../src/core/terminal-querier.js'
import { registerTerminalPoll } from './terminalPollRegistry.js'
import {
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from '../src/theme/systemTheme.js'

/** OSC 11 = "text background color". The answer is what we classify. */
const OSC_BACKGROUND_COLOR = 11

/**
 * How often to re-query the terminal background.
 *
 * There is no standard way for a terminal to *push* a theme change, so
 * following the system appearance means polling. 3s is under the threshold
 * where a manual OS light/dark flip feels laggy, while the cost is one tiny
 * escape-sequence round-trip — a few dozen bytes that never reach the screen.
 */
const POLL_INTERVAL_MS = 3_000

/**
 * Track the terminal's light/dark appearance while the 'auto' theme is active.
 *
 * Returns a cleanup that stops polling. Safe to call when the terminal doesn't
 * support OSC 11: the first query settles as `undefined` (the querier's DA1
 * sentinel bounds it — no timeout needed) and we stop polling permanently
 * rather than reissuing a query this terminal has already proven it ignores.
 */
export function watchSystemTheme(
  querier: TerminalQuerier,
  setTheme: React.Dispatch<React.SetStateAction<SystemTheme>>,
): () => void {
  let stopped = false
  let inFlight = false
  let timer: ReturnType<typeof setInterval> | undefined
  let unregister: (() => void) | undefined

  const stop = (): void => {
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    unregister?.()
    unregister = undefined
  }

  async function poll(): Promise<void> {
    // Never stack queries: a terminal that is slow to answer (or an event loop
    // blocked by a heavy render) would otherwise accumulate one pending query
    // per tick, and each carries a DA1 sentinel write.
    if (stopped || inFlight) return
    inFlight = true
    try {
      const [response] = await Promise.all([
        querier.send(oscColor(OSC_BACKGROUND_COLOR)),
        querier.flush(),
      ])
      if (stopped) return
      if (!response) {
        // Terminal ignored OSC 11 — it will keep ignoring it. Stop rather than
        // burning a round-trip every interval for the rest of the session.
        stop()
        return
      }
      const theme = themeFromOscColor(response.data)
      // Unparseable payload: keep the previous value. Guessing here would
      // flip the whole palette on a malformed reply.
      if (!theme) return
      // Keep the module-level cache in step so non-React callers that resolve
      // 'auto' synchronously (resolveThemeSetting) agree with what's rendered.
      setCachedSystemTheme(theme)
      setTheme(theme)
    } catch {
      // Never let a terminal quirk take down the render tree; just stop.
      stop()
    } finally {
      inFlight = false
    }
  }

  // Registered so shutdown can stop the poll without React unmounting — see
  // terminalPollRegistry.ts for why that path is not reachable on Ctrl+C.
  unregister = registerTerminalPoll(stop)

  // Fire immediately so switching to 'auto' corrects the $COLORFGBG seed
  // (or the 'dark' default) on the first frame rather than after a full
  // interval of showing the wrong palette.
  void poll()
  timer = setInterval(() => void poll(), POLL_INTERVAL_MS)
  // Don't hold the process open on this timer — it is passive observation.
  timer.unref?.()

  return stop
}
