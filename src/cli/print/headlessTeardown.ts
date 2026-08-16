/**
 * The one way a headless session closes its output stream.
 *
 * Two call sites reach it — the turn loop, when input is already closed and
 * no swarm needs shutting down, and the stdin reader, when input closes while
 * no turn is running. Both ran byte-identical teardown blocks before; keeping
 * one copy here means an added teardown step can't be forgotten on one path.
 * Lives in its own leaf module so neither driver has to import the other.
 */
import { statusListeners } from 'src/services/claudeAiLimits.js'
import { finalizePendingAsyncHooks } from 'src/utils/hooks/AsyncHookRegistry.js'
import { sleep } from 'src/utils/process/sleep.js'
import { teardownHeadlessBridge } from './headlessBridge.js'
import type { HeadlessRunState } from './headlessRunState.js'

export async function finalizeHeadlessOutput(
  state: HeadlessRunState,
): Promise<void> {
  // If a push-suggestion is in-flight, wait for it to emit before closing the
  // output stream (5 s safety timeout to prevent hanging).
  if (state.suggestionState.inflightPromise) {
    await Promise.race([state.suggestionState.inflightPromise, sleep(5000)])
  }
  state.suggestionState.abortController?.abort()
  state.suggestionState.abortController = null
  await finalizePendingAsyncHooks()
  state.unsubscribeSkillChanges()
  state.unsubscribeAuthStatus?.()
  statusListeners.delete(state.rateLimitListener)
  await teardownHeadlessBridge(state)
  state.output.done()
}
