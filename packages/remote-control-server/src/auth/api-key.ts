import { createHash, timingSafeEqual } from 'node:crypto'
import { config } from '../config'

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/** Validate a legacy API key only when explicitly enabled. */
export function validateApiKey(token: string | undefined): boolean {
  if (!config.legacyApiKeyAuth || !token) return false
  const tokenHash = sha256(token)
  return config.apiKeys.some(key => timingSafeEqual(tokenHash, sha256(key)))
}
