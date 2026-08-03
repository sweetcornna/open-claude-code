/**
 * Host facade for "do we hold credentials for this search provider?".
 *
 * WebSearch aggregates one lane per connected provider, so the source
 * resolver has to ask about Claude / Google / ChatGPT logins. Those probes
 * live deep in host auth (keychain, OAuth stores, env), and importing them
 * from the leaf package puts src/utils/auth in a dependency cycle with the
 * tool graph. The host registers its implementation during tool assembly
 * instead; see src/services/search/sourceCredentials.ts.
 *
 * Unregistered fallback: "no credentials". Standalone package use and unit
 * tests then aggregate only the sources that need no account, which is the
 * safe direction — the alternative would fire authenticated lanes with no
 * auth on every search.
 */

export type SearchCredentialFamily = 'anthropic' | 'gemini' | 'codex'

export type SearchCredentialProbe = (family: SearchCredentialFamily) => boolean

let probe: SearchCredentialProbe | null = null

export function registerSearchCredentialProbe(
  hostProbe: SearchCredentialProbe,
): void {
  probe = hostProbe
}

export function hasSearchCredentials(family: SearchCredentialFamily): boolean {
  return probe ? probe(family) : false
}

/** Test seam — drop the registration so the fallback applies again. */
export function resetSearchCredentialProbe(): void {
  probe = null
}
