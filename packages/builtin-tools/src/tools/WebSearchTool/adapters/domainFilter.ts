/**
 * Client-side allow/block domain filtering, shared by the adapters whose
 * backend cannot enforce the lists server-side.
 *
 * Subdomains count as a match on both lists (`example.com` matches
 * `docs.example.com`), and a result whose URL does not parse is dropped — the
 * tool hands these URLs to the model, so an unparseable one is never useful.
 */

import type { SearchResult } from './types.js'

export function filterResultsByDomains(
  results: SearchResult[],
  allowedDomains: string[] | undefined,
  blockedDomains: string[] | undefined,
): SearchResult[] {
  if (!allowedDomains?.length && !blockedDomains?.length) return results

  return results.filter(result => {
    if (!result.url) return false
    let hostname: string
    try {
      hostname = new URL(result.url).hostname
    } catch {
      return false
    }
    const matches = (domain: string): boolean =>
      hostname === domain || hostname.endsWith(`.${domain}`)
    if (allowedDomains?.length && !allowedDomains.some(matches)) return false
    if (blockedDomains?.length && blockedDomains.some(matches)) return false
    return true
  })
}
