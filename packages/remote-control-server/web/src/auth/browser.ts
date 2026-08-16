const LEGACY_ACCOUNT_STORAGE_KEYS = ['rcs_uuid', 'rcs_tokens'] as const

type PairingLocation = Pick<Location, 'hash' | 'href'>
type PairingHistory = Pick<History, 'replaceState' | 'state'>
type BrowserStorage = Pick<Storage, 'removeItem'>

/**
 * Pairing credentials live only long enough to cross the URL boundary. Remove
 * them before React mounts so they cannot leak through screenshots, copied
 * links, referrers, or a second StrictMode effect.
 */
export function readAndScrubPairingCode(
  location: PairingLocation = window.location,
  history: PairingHistory = window.history,
): string | null {
  if (!location.hash.startsWith('#')) return null

  const fragment = new URLSearchParams(location.hash.slice(1))
  const pairingCode = fragment.get('pair')
  if (!pairingCode) return null

  fragment.delete('pair')
  const url = new URL(location.href)
  const remainingFragment = fragment.toString()
  url.hash = remainingFragment ? `#${remainingFragment}` : ''
  history.replaceState(
    history.state,
    '',
    `${url.pathname}${url.search}${url.hash}`,
  )

  return pairingCode
}

/** Remove credentials left by the pre-account browser identity model. */
export function purgeLegacyAccountCredentials(
  storage: BrowserStorage = window.localStorage,
): void {
  for (const key of LEGACY_ACCOUNT_STORAGE_KEYS) {
    try {
      storage.removeItem(key)
    } catch {
      // Storage may be unavailable in hardened browser contexts.
    }
  }
}
