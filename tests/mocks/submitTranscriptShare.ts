/**
 * Shared complete-surface mock for
 * src/components/FeedbackSurvey/submitTranscriptShare.js.
 *
 * The real export uploads the session transcript, so every suite that renders a
 * feedback survey has to stub it. Because Bun's mock registry is process-global,
 * that stub is installed for the rest of the shard — so it has to be a complete
 * delegating surface rather than the single function the suite happens to call.
 * See tests/mocks/sharedModuleMock.ts.
 *
 * Usage:
 *   import { setupSubmitTranscriptShareMock } from '<relative>/tests/mocks/submitTranscriptShare.js'
 *   const m = setupSubmitTranscriptShareMock({ submitTranscriptShare: spy })
 *   afterAll(() => m.reset())
 */

import * as realSubmitTranscriptShare from 'src/components/FeedbackSurvey/submitTranscriptShare.js'
import {
  makeSharedModuleMock,
  type ModuleOverrides,
} from './sharedModuleMock.js'

export type SubmitTranscriptShareOverrides = ModuleOverrides<
  typeof realSubmitTranscriptShare
>

const shared = makeSharedModuleMock(
  'src/components/FeedbackSurvey/submitTranscriptShare.js',
  realSubmitTranscriptShare,
)

export function setupSubmitTranscriptShareMock(
  initial: SubmitTranscriptShareOverrides = {},
): {
  set(overrides: SubmitTranscriptShareOverrides): void
  reset(): void
} {
  return shared.setup(initial)
}
