/**
 * The desktop-Chrome request identity the keyless SERP engines are fetched
 * with.
 *
 * Keyless search endpoints gate on the *shape* of the request, not just the
 * User-Agent. A UA string with no accompanying client hints reads as an
 * obviously scripted client: `html.duckduckgo.com` answers it with an HTTP 202
 * anomaly/challenge page instead of results, which parses to zero rows and is
 * indistinguishable from "this query found nothing".
 *
 * Sending the full Chrome 131 set — client hints (`sec-ch-ua*`) alongside the
 * fetch metadata, in the order Chrome itself emits them — is what clears that
 * gate. Verified against the live endpoint: DuckDuckGo goes from `202` with 0
 * parsed rows to `200` with 10.
 *
 * What this deliberately does NOT claim to solve: engines that fingerprint the
 * TLS handshake (JA3) or the HTTP/2 SETTINGS frame rather than the headers.
 * `www4.bing.com` and `www.mojeek.com` both do, and both still answer a
 * Node/Bun client with a CAPTCHA no header set can talk it out of — upstream
 * free-search-mcp only gets past them by way of curl_cffi's browser
 * impersonation, which has no dependency-free equivalent here. Those engines
 * stay in the pool as best-effort; the gate detector (gate.ts) is what keeps
 * their refusal honest instead of silent, and the keyless JSON APIs
 * (apiEngines.ts) are what actually backstops them.
 */

/** Chrome 131 on macOS, headers in Chrome's own emission order. */
export const BROWSER_HEADERS = {
  'sec-ch-ua':
    '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'Upgrade-Insecure-Requests': '1',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-User': '?1',
  'Sec-Fetch-Dest': 'document',
  'Accept-Language': 'en-US,en;q=0.9',
} as const

/**
 * Headers for the keyless JSON APIs. They serve machines by design, so the
 * browser costume is not only unnecessary but wrong — several of them vary
 * their response on `Accept`. A descriptive User-Agent is what their operators
 * ask for (GitHub rejects requests without one outright).
 */
export const JSON_API_HEADERS = {
  'User-Agent': 'open-claude-code/websearch (+https://github.com/sweetcornna)',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
} as const
