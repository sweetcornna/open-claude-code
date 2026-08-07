/**
 * Shared complete-surface mock for src/utils/session/sdkEventQueue.js.
 *
 * Suites that want to capture emitted SDK events hand-rolled
 * `mock.module('…/sdkEventQueue.js', () => ({ enqueueSdkEvent: … }))`, which
 * erases `drainSdkEvents` / `emitTaskTerminatedSdk` for every file loaded
 * afterwards in the same shard — Bun's mock registry is process-global and
 * last-write-wins. See tests/mocks/sharedModuleMock.ts for the full failure
 * mode.
 *
 * The real `enqueueSdkEvent` drops everything unless the session is
 * non-interactive, so a capturing override is normally still required; what
 * changes is that the other exports keep delegating to the real module.
 *
 * Usage:
 *   import { setupSdkEventQueueMock } from '<relative>/tests/mocks/sdkEventQueue.js'
 *   const events: unknown[] = []
 *   const m = setupSdkEventQueueMock({
 *     enqueueSdkEvent: event => {
 *       events.push(event)
 *     },
 *   })
 *   afterAll(() => m.reset())
 */

import * as realSdkEventQueue from 'src/utils/session/sdkEventQueue.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SdkEventQueueOverrides = ModuleOverrides<typeof realSdkEventQueue>

const shared = makeSharedModuleMock(
  'src/utils/session/sdkEventQueue.js',
  realSdkEventQueue,
)

export function setupSdkEventQueueMock(initial: SdkEventQueueOverrides = {}): {
  set(overrides: SdkEventQueueOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
