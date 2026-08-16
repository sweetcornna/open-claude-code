import { feature } from 'bun:bundle'
import { registerRemoteControlHost } from '@open-claude-code/tool-runtime/remoteControl.js'

if (feature('BRIDGE_MODE')) {
  const { isBridgeEnabled } = require('./bridgeEnabled.js') as {
    isBridgeEnabled(): boolean
  }
  const { isEnvTruthy } = require('../utils/config/envUtils.js') as {
    isEnvTruthy(value: string | undefined): boolean
  }

  registerRemoteControlHost({
    isEnabled: isBridgeEnabled,
    getAtStartup() {
      const { getRemoteControlAtStartup } =
        require('../utils/config/config.js') as {
          getRemoteControlAtStartup(): boolean
        }
      return getRemoteControlAtStartup()
    },
    shouldUploadAttachments(replBridgeEnabled) {
      return (
        replBridgeEnabled || isEnvTruthy(process.env.CLAUDE_CODE_BRIEF_UPLOAD)
      )
    },
    async uploadAttachment(fullPath, size, context) {
      const { uploadBriefAttachment } = await import('./briefUpload.js')
      return uploadBriefAttachment(fullPath, size, context)
    },
    async sendPushNotification(notification) {
      const { sendBridgePushNotification } = await import(
        './pushNotification.js'
      )
      return sendBridgePushNotification(notification)
    },
  })
}
