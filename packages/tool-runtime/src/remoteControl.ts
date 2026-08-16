export type RemoteControlAttachmentContext = {
  replBridgeEnabled: boolean
  signal?: AbortSignal
}

export type RemoteControlPushNotification = {
  title: string
  body: string
  priority: 'normal' | 'high'
}

export interface RemoteControlHost {
  isEnabled(): boolean
  getAtStartup(): boolean
  shouldUploadAttachments(replBridgeEnabled: boolean): boolean
  uploadAttachment(
    fullPath: string,
    size: number,
    context: RemoteControlAttachmentContext,
  ): Promise<string | undefined>
  sendPushNotification(
    notification: RemoteControlPushNotification,
  ): Promise<boolean>
}

let host: RemoteControlHost | null = null

export function registerRemoteControlHost(value: RemoteControlHost): void {
  host = value
}

export function isRemoteControlEnabled(): boolean {
  return host?.isEnabled() ?? false
}

export function getRemoteControlAtStartup(): boolean {
  return host?.getAtStartup() ?? false
}

export function shouldUploadRemoteControlAttachments(
  replBridgeEnabled: boolean,
): boolean {
  return host?.shouldUploadAttachments(replBridgeEnabled) ?? false
}

export async function uploadRemoteControlAttachment(
  fullPath: string,
  size: number,
  context: RemoteControlAttachmentContext,
): Promise<string | undefined> {
  return host?.uploadAttachment(fullPath, size, context)
}

export async function sendRemoteControlPushNotification(
  notification: RemoteControlPushNotification,
): Promise<boolean> {
  return host?.sendPushNotification(notification) ?? false
}
