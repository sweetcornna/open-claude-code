/**
 * Google Antigravity OAuth — public surface.
 *
 * Pinned contract for the three entry points that consume this module
 * (/login, the onboarding wizard, and /search-setting's Gemini search source):
 *
 *   startAntigravityOAuthLogin(): Promise<AntigravityLoginResult>
 *   getAntigravityAccessToken(): Promise<string | null>
 *
 * The Gemini request path deliberately imports './oauth.js' directly instead of
 * this barrel: pulling in login.js there would drag the callback server and the
 * browser launcher into every model call.
 */

export {
  startAntigravityOAuthLogin,
  type AntigravityLoginOptions,
  type AntigravityLoginResult,
} from './login.js'

export {
  getAntigravityAccessToken,
  getValidAntigravityAuth,
  hasAntigravityCredentials,
  removeAntigravityAuth,
  type AntigravityAuth,
  type AntigravityTokens,
} from './oauth.js'

export { antigravityAuthFilePath } from './store.js'
