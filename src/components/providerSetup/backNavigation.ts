/**
 * Back-navigation that declines instead of firing from a screen that is gone.
 *
 * ConsoleOAuthFlow's OAuthStatusMessage calls hooks inside its `switch`, so a
 * screen's key handler outlives the render that created it: the previous
 * screen's Esc handler is still registered and still runs first. `useKeybinding`
 * treats any handler that does not return `false` as having consumed the key, so
 * one Esc either walked back two screens (both handlers navigating) or died on
 * the stale one — depending on which was registered first.
 *
 * Returning `false` is the documented way to decline a keypress and let it reach
 * the handler that is current. The live state has to come from a ref: the stale
 * handler's closure necessarily holds an old one.
 *
 * This is a containment measure. The real fix is to stop calling hooks inside
 * that switch, at which point every caller here can go back to a plain setter.
 */

type Screen = { state: string }

export type BackNavigationRef<S extends Screen> = {
  readonly current: S | null
}

/**
 * Move to `to`, but only while `from` is still the screen on display.
 *
 * @returns `false` when the caller's screen is stale — pass it straight back out
 *   of the key handler so the event keeps propagating.
 */
export function backFromScreen<S extends Screen>(
  liveScreen: BackNavigationRef<S>,
  navigate: (to: S) => void,
  from: S['state'],
  to: S,
): void | false {
  if (liveScreen.current?.state !== from) return false
  navigate(to)
}
