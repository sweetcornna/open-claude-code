/**
 * The startup notice for a context window that is not the one the settings say.
 *
 * `settings.modelSettings.<tier>.contextTokens` is occ's own feature — upstream
 * has no per-tier window — and it shipped without either half of the correction
 * upstream applies to its single global knob: the hard cap against what the
 * model actually serves, and telling the user it happened. The cap now lives in
 * `clampConfiguredContextWindow`; this is the telling-the-user half, because a
 * window that silently shrinks from 372k to 200k looks exactly like occ ignoring
 * the setting.
 *
 * Two cases, in priority order:
 *
 *   capped  — the user asked for more than the endpoint will serve. Actionable:
 *             `[1m]` gets the wide window, anything else has to come down.
 *   assumed — nothing in occ recognises the model, so the 200k it is accounting
 *             with is a guess rather than a fact. Only fires when the user has
 *             NOT already answered the question (an env override or a per-tier
 *             setting both win outright, which moves `source` off
 *             `family-default` and silences this).
 *
 * Read at render time from the resolved main-loop model, so it reflects `[1m]`
 * exactly as the request will carry it.
 */

import { getMainLoopModel } from '../model/model.js'
import {
  getConfiguredContextWindowCap,
  isAssumedContextWindow,
} from '../session/context.js'

export type ContextWindowNotice =
  | { kind: 'capped'; model: string; configured: number; window: number }
  | { kind: 'assumed'; model: string }

/**
 * The notice for a resolved model, or null.
 *
 * Takes the model rather than calling `getMainLoopModel()` so tests can state a
 * session without standing up the model-resolution chain.
 */
export function getContextWindowNoticeForModel(
  model: string,
  betas?: string[],
): ContextWindowNotice | null {
  const cap = getConfiguredContextWindowCap(model, betas)
  if (cap) {
    return {
      kind: 'capped',
      model,
      configured: cap.configured,
      window: cap.window,
    }
  }
  if (isAssumedContextWindow(model, betas)) {
    return { kind: 'assumed', model }
  }
  return null
}

/**
 * The notice for the current session, or null.
 *
 * No betas argument, deliberately. The only beta that changes the answer is
 * `context-1m`, and on the main-loop model that header exists exactly when the
 * id carries `[1m]` — which `getMainLoopModel()` has already applied and the
 * resolver reads straight off the string. Reaching for `getSdkBetas()` to say
 * the same thing twice costs an import of `bootstrap/state`, and the status
 * notices are reachable from `REPL.tsx`, so that edge closes a new import cycle
 * (`check:cycles` is a strict two-way ratchet).
 *
 * Swallows failures on purpose: this runs inside a status-notice `isActive`,
 * where the model-resolution chain is reachable but a throw would take the whole
 * startup banner down over a diagnostic.
 */
export function getContextWindowNotice(): ContextWindowNotice | null {
  try {
    return getContextWindowNoticeForModel(getMainLoopModel())
  } catch {
    return null
  }
}
