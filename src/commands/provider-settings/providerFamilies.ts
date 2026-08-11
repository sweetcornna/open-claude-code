/**
 * The provider FAMILY axis — `/provider-settings openai`, `… bedrock`,
 * `… unset` — which is what `/provider` did before the two commands merged.
 *
 * A different axis from profiles, and both have to keep working:
 *
 *   - a PROFILE is a named snapshot of every managed key, and activating one
 *     is a whole-shape write (see activate.ts);
 *   - a FAMILY switch only says which provider `getAPIProvider()` should
 *     answer, leaving whatever credentials are already in the environment
 *     alone. It is what a user reaches for after exporting the keys by hand.
 *
 * So `/provider-settings openai` and `/provider-settings use openai` are not
 * the same request even when a profile happens to be called `openai`; the
 * parser tells them apart by position.
 *
 * Pure, and kept apart from ./providerSwitch.ts for that reason: the parser
 * needs to recognise a family name and the warning needs to be checkable
 * without a settings file, while performing the switch is three writes to the
 * live process.
 */

/** Families `/provider <name>` has always accepted. */
export const PROVIDER_FAMILIES = [
  'anthropic',
  'openai',
  'gemini',
  'grok',
  'bedrock',
  'vertex',
  'foundry',
] as const

export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number]

export function isProviderFamily(value: string): value is ProviderFamily {
  return (PROVIDER_FAMILIES as readonly string[]).includes(value)
}

/**
 * What this family still needs before it can answer a request, given the
 * merged environment. Empty when it is ready — or when occ cannot tell, which
 * is the case for every family whose credentials live in an external toolchain.
 *
 * Naming a variable here is not the thing the panel refuses to print: a
 * variable the user has NOT set is an instruction, while the key a profile HAS
 * stored is a secret and never appears anywhere.
 */
export function missingProviderEnv(
  provider: ProviderFamily,
  mergedEnv: Readonly<Record<string, string | undefined>>,
): string[] {
  if (provider === 'openai') {
    // A ChatGPT subscription carries its own credentials, so neither key nor
    // endpoint is missing in that mode.
    if (mergedEnv.OPENAI_AUTH_MODE === 'chatgpt') return []
    const missing: string[] = []
    if (!mergedEnv.OPENAI_API_KEY) missing.push('OPENAI_API_KEY')
    if (!mergedEnv.OPENAI_BASE_URL) missing.push('OPENAI_BASE_URL')
    return missing
  }
  if (provider === 'grok') {
    // Either name works; xAI's own is XAI_API_KEY.
    return mergedEnv.GROK_API_KEY || mergedEnv.XAI_API_KEY
      ? []
      : ['GROK_API_KEY (or XAI_API_KEY)']
  }
  // GEMINI_BASE_URL has a working default, so only the key can be missing.
  if (provider === 'gemini') {
    return mergedEnv.GEMINI_API_KEY ? [] : ['GEMINI_API_KEY']
  }
  return []
}

/** The wording each half-configured family reports, carried over verbatim. */
export function describeMissingProviderEnv(
  provider: ProviderFamily,
  missing: string[],
): string {
  if (provider === 'grok') {
    return (
      `Switched to Grok provider.\nWarning: Missing env var: ${missing.join(', ')}\n` +
      `Configure it via settings.json env or set manually.`
    )
  }
  if (provider === 'gemini') {
    return (
      `Switched to Gemini provider.\nWarning: Missing env var: ${missing.join(', ')}\n` +
      `Configure it via /login or set manually.`
    )
  }
  return (
    `Switched to OpenAI provider.\nWarning: Missing env vars: ${missing.join(', ')}\n` +
    `Configure them via /login or set manually.`
  )
}
