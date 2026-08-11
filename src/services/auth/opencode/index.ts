/**
 * OpenCode authentication — the surface the SCREENS use.
 *
 * Deliberately narrow. The request path (`services/api/opencodeCredential.ts`)
 * imports `./oauth.js` directly and must keep doing so: re-exporting through
 * here would pull the device-flow transport and, with it, the browser launcher
 * into every model call. Same split as the Antigravity module.
 *
 * Every name below has a caller. An export nobody imports is not a courtesy —
 * it is surface the dead-code ratchet has to carry and the next reader has to
 * evaluate.
 */

export {
  OPENCODE_API_KEY_ENV,
  OPENCODE_CONSOLE_URL,
  OPENCODE_ZEN_BASE_URL,
} from './constants.js'
// OPENCODE_GO_BASE_URL is deliberately absent: the screens address the two
// products through `OPENCODE_PRODUCTS` (components/opencodeLogin/
// opencodeCatalog.ts), which is where the base URL, the label, the billing
// model and the catalog stay in one row. A second way to reach one of those
// four fields is how they drift apart.

export {
  fetchAccount,
  pollForTokens,
  requestDeviceCode,
  type DeviceCodeGrant,
  type OpencodeAccount,
} from './deviceFlow.js'

export {
  fetchOpencodeModels,
  fetchZenModels,
  verifyOpencodeAccess,
  type OpencodeAccessCheck,
} from './catalog.js'

export { saveOpencodeTokens } from './store.js'
