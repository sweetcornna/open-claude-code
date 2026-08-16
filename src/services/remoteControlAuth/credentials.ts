import { createHash } from 'node:crypto'
import { deleteSecret, getSecret, setSecret } from '../localVault/store.js'
import { normalizeRemoteControlBaseUrl } from './state.js'
import type { StoredRemoteControlCredential } from './types.js'

function credentialKey(baseUrl: string): string {
  const scope = createHash('sha256')
    .update(normalizeRemoteControlBaseUrl(baseUrl))
    .digest('hex')
    .slice(0, 32)
  return `remote-control-auth.${scope}`
}

export async function readRemoteControlCredential(
  baseUrl: string,
): Promise<StoredRemoteControlCredential | null> {
  const raw = await getSecret(credentialKey(baseUrl))
  if (!raw) return null

  try {
    const value = JSON.parse(raw) as Partial<StoredRemoteControlCredential>
    const normalizedBaseUrl = normalizeRemoteControlBaseUrl(baseUrl)
    if (
      value.version !== 1 ||
      value.baseUrl !== normalizedBaseUrl ||
      typeof value.username !== 'string' ||
      typeof value.refreshToken !== 'string' ||
      value.refreshToken.length === 0
    ) {
      return null
    }
    return value as StoredRemoteControlCredential
  } catch {
    return null
  }
}

export async function saveRemoteControlCredential(
  baseUrl: string,
  username: string,
  refreshToken: string,
): Promise<void> {
  const value: StoredRemoteControlCredential = {
    version: 1,
    baseUrl: normalizeRemoteControlBaseUrl(baseUrl),
    username,
    refreshToken,
  }
  await setSecret(credentialKey(baseUrl), JSON.stringify(value))
}

export async function clearRemoteControlCredential(
  baseUrl: string,
): Promise<boolean> {
  return deleteSecret(credentialKey(baseUrl))
}
