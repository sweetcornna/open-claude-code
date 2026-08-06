/**
 * Gate detection for keyless SERP responses.
 *
 * A CAPTCHA, consent wall or JS-only shell served INSTEAD of results is an
 * HTTP 200 (or DuckDuckGo's 202) carrying a page our selectors match zero rows
 * in. Without this check that outcome is indistinguishable from an honest
 * "this query found nothing", and the difference matters twice over:
 *
 *   - The escalation in freeAdapter.ts only spends extra network when the run
 *     looks *unhealthy*. A silently-gated engine reads as healthy-but-empty,
 *     so a fully walled pool would return `[]` without ever trying the
 *     backstops.
 *   - An empty result list reaches the model as "the web has no answer" —
 *     a false statement it will happily relay to the user. A gated engine has
 *     to surface as an error instead.
 *
 * Ported from free-search-mcp's `_GATE_MARKERS` (sweetcornna/free-search-mcp @
 * v0.9.1, 7933a002). The markers are the load-bearing part and they rot with
 * the SERPs; re-check them against that file when an engine starts returning
 * suspiciously empty runs.
 */

/** Why a page was rejected. Ordered by priority: captcha > javascript > consent > login. */
export type GateReason = 'captcha' | 'javascript' | 'consent' | 'login'

const GATE_MARKERS: readonly (readonly [GateReason, readonly string[]])[] = [
  [
    'captcha',
    [
      '/sorry/index', // Google's interstitial
      'unusual traffic',
      '/recaptcha/',
      'g-recaptcha',
      'h-captcha',
      'captcha-delivery',
      'px-captcha',
      'are you a robot',
      'verify you are a human',
      // DuckDuckGo's anomaly page (HTTP 202) never contains the literal
      // "captcha" — it asks the visitor to "select all squares containing a
      // duck". Without these two markers a gated DDG, the pool's most
      // productive engine, is a silent empty.
      'anomaly-modal',
      'made by a human',
      // Mojeek serves an ALTCHA proof-of-work challenge titled "Captcha" whose
      // markup shares none of the markers above.
      'captcha-wrap',
      'altcha',
      'verification required',
      'complete the challenge',
      // Anubis, the proof-of-work interstitial most public SearXNG instances
      // now sit behind. Its page title is the giveaway.
      "making sure you're not a bot",
      'making sure you&#39;re not a bot',
    ],
  ],
  [
    // Not a challenge to solve — a JS-only shell served in place of results.
    'javascript',
    [
      'if you are not redirected',
      'please click here if you are not',
      'enable javascript to continue',
      'javascript is required',
    ],
  ],
  [
    'consent',
    [
      'consent.google.com',
      'consent.youtube.com',
      'consent.bing.com',
      'before you continue',
    ],
  ],
  [
    'login',
    ['sign in to continue', 'you must log in', 'please log in to continue'],
  ],
]

/**
 * Classify `html` as a gate page, or undefined when it looks like real output.
 *
 * Best-effort and deliberately cheap: this only ever runs on a response that
 * already parsed to zero results, so a false negative costs nothing beyond the
 * status quo and a false positive would only mislabel an already-empty run.
 */
export function detectGate(html: string): GateReason | undefined {
  if (!html) return undefined
  const haystack = html.toLowerCase()
  for (const [reason, markers] of GATE_MARKERS) {
    if (markers.some(marker => haystack.includes(marker))) return reason
  }
  return undefined
}

/**
 * A keyless engine that answered with a wall rather than results.
 *
 * Carries the engine name so the "everything failed" path can tell the user
 * *which* backend refused and why, rather than surfacing a bare network error
 * from whichever lane happened to be first.
 */
export class GatedEngineError extends Error {
  constructor(
    readonly engineName: string,
    readonly reason: GateReason,
  ) {
    super(
      `${engineName} was ${reason}-gated (served a wall instead of results)`,
    )
    this.name = 'GatedEngineError'
  }
}
