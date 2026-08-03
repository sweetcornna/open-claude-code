/**
 * One URL normalization rule for the whole search stack.
 *
 * Two different backends routinely return the same page under different
 * spellings — a fragment, a trailing slash, or a pile of campaign parameters
 * one engine kept and the other stripped. Dedup keys (and the URL we finally
 * hand the model) go through here so the same page is the same result.
 *
 * Deliberately conservative: only well-known *tracking* parameters are
 * dropped. Anything else can be load-bearing (`?q=`, `?id=`, `?page=`), and a
 * wrong strip produces a URL that 404s in front of the user.
 */

/** Campaign/click-id parameters that never change what a URL resolves to. */
const TRACKING_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'utm_reader',
  'gclid',
  'gclsrc',
  'dclid',
  'fbclid',
  'msclkid',
  'yclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref_src',
  'ref_url',
  'spm',
  '_ga',
  '_gl',
])

export function normalizeUrlForDedup(rawUrl: string): string {
  if (!rawUrl) return rawUrl
  const absolute = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl

  let parsed: URL
  try {
    parsed = new URL(absolute)
  } catch {
    // Not parseable (relative href, malformed engine output): fall back to the
    // textual rules so callers still get stable dedup behaviour.
    return (absolute.split('#')[0] ?? '').replace(/\/+$/, '')
  }

  parsed.hash = ''
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) {
      parsed.searchParams.delete(key)
    }
  }
  parsed.hostname = parsed.hostname.toLowerCase()
  // Trailing slashes never distinguish two pages in practice and engines
  // disagree about emitting them. Strip on the PATH, not on the whole string:
  // with a query attached the slash is in the middle (`/p/?id=7`).
  parsed.pathname = parsed.pathname.replace(/\/+$/, '')

  let normalized = parsed.toString()
  // URL.toString() re-adds a bare '?' when every param was stripped, and a '/'
  // for an empty path.
  normalized = normalized.replace(/\?$/, '')
  return normalized.replace(/\/+$/, '')
}
