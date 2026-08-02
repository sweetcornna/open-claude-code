import { useMemo } from 'react'
import { useOptionalKeybindingContext } from './KeybindingContext.js'
import { loadKeybindingsSync } from './loadUserBindings.js'
import type { KeybindingContextName, ParsedBinding } from './types.js'

/**
 * Derive the printable keys a type-to-search fallback must NOT treat as
 * search input, because a sibling keybinding handler consumes them.
 *
 * List panels (Settings config, permission rules) register actions via
 * useKeybindings but also accept "any other printable character" to enter
 * search mode through an independent onKeyDown path. The two dispatch paths
 * don't see each other, so the search fallback needs to know which keys the
 * bindings own. Deriving that set from the live binding table (instead of
 * hardcoding 'j'/'k'/'/') keeps it correct when users rebind.
 *
 * Scope this to the ACTIONS the calling panel actually handles, not to every
 * binding in its contexts: 'r' is bound to settings:retry in the Settings
 * context, but the config panel doesn't handle that action, so 'r' must keep
 * typing into the search box there.
 *
 * Mirrors resolveKey's semantics: bindings are scanned in array order and
 * the last match per key wins, so a user override that remaps or unbinds a
 * default key (action: null) takes effect here too.
 */
export function derivePlainCharExclusions(
  bindings: ParsedBinding[],
  contexts: readonly KeybindingContextName[],
  actions: readonly string[],
): Set<string> {
  const ctxSet = new Set<KeybindingContextName>(contexts)
  const actionSet = new Set<string>(actions)

  const lastActionPerKey = new Map<string, string | null>()
  for (const binding of bindings) {
    if (binding.chord.length !== 1) continue
    if (!ctxSet.has(binding.context)) continue
    const ks = binding.chord[0]
    if (!ks) continue
    // Only plain printable characters — the search fallbacks already ignore
    // modifier combos and multi-char key names ('up', 'wheeldown', …).
    if (ks.key.length !== 1) continue
    if (ks.ctrl || ks.alt || ks.meta || ks.shift || ks.super) continue
    lastActionPerKey.set(ks.key, binding.action)
  }

  const excluded = new Set<string>()
  for (const [key, action] of lastActionPerKey) {
    if (action !== null && actionSet.has(action)) {
      excluded.add(key)
    }
  }
  return excluded
}

/**
 * React wrapper over derivePlainCharExclusions using the provider's binding
 * table (falls back to the sync loader outside a KeybindingProvider).
 *
 * Pass module-level constants for `contexts` and `actions` — the memo is
 * keyed on their identity.
 */
export function useSearchExclusionKeys(
  contexts: readonly KeybindingContextName[],
  actions: readonly string[],
): Set<string> {
  const keybindingContext = useOptionalKeybindingContext()
  const bindings = keybindingContext?.bindings
  return useMemo(
    () =>
      derivePlainCharExclusions(
        bindings ?? loadKeybindingsSync(),
        contexts,
        actions,
      ),
    [bindings, contexts, actions],
  )
}
