import axios from 'axios'
import type { RemoteControlPushNotification } from '@open-claude-code/tool-runtime/remoteControl.js'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/telemetry/debug.js'
import { getBridgeAccessToken, getBridgeBaseUrl } from './bridgeConfig.js'

export async function sendBridgePushNotification(
  notification: RemoteControlPushNotification,
): Promise<boolean> {
  try {
    const token = getBridgeAccessToken()
    const sessionId = getSessionId()
    if (!token || !sessionId) return false

    const response = await axios.post(
      `${getBridgeBaseUrl()}/v1/sessions/${sessionId}/events`,
      {
        events: [
          {
            type: 'push_notification',
            ...notification,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        timeout: 10_000,
        validateStatus: (status: number) => status < 500,
      },
    )
    if (response.status >= 200 && response.status < 300) {
      logForDebugging(
        `[PushNotification] delivered via bridge session=${sessionId}`,
      )
      return true
    }
    logForDebugging(
      `[PushNotification] bridge delivery failed: status=${response.status}`,
    )
  } catch (error) {
    logForDebugging(`[PushNotification] bridge delivery error: ${error}`)
  }
  return false
}
