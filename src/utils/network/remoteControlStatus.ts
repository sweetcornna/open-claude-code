import { getBridgeBaseUrlOverride } from '../../bridge/bridgeBaseUrl.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  isSelfHostedBridge,
} from '../../bridge/bridgeConfig.js'

/**
 * Three endpoints are worth telling apart here, not two: an unconfigured occ
 * now reaches the project's public server, and reporting that as "self-hosted"
 * would send people looking for a deployment they never made.
 */
function describeEndpoint(): string {
  if (!isSelfHostedBridge()) return 'official (claude.ai)'
  return getBridgeBaseUrlOverride() ? 'self-hosted' : 'default (public server)'
}

export function formatRemoteControlLocalStatus(): string {
  try {
    const token = getBridgeAccessToken()
    return [
      `Remote Control: ${describeEndpoint()}`,
      `  base_url=${getBridgeBaseUrl()}`,
      `  token=${token ? 'present' : 'missing'}`,
      '  entitlement=checked at remote-control startup',
    ].join('\n')
  } catch (error) {
    return [
      'Remote Control: unknown',
      `  reason=${error instanceof Error ? error.message : String(error)}`,
    ].join('\n')
  }
}
