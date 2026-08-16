import { ACPClient } from './client'

/** Build the same-origin RCS relay URL for a given agent. */
export function buildRelayUrl(agentId: string): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/acp/relay/${encodeURIComponent(agentId)}`
}

/**
 * Create an ACP client through the account-authenticated RCS relay. Browser
 * WebSockets send the same-origin HttpOnly session cookie during the upgrade.
 */
export function createRelayClient(agentId: string): ACPClient {
  return new ACPClient({ proxyUrl: buildRelayUrl(agentId) })
}
