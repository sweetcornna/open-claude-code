import {
  type RemoteControlAttachmentContext,
  uploadRemoteControlAttachment,
} from '@open-claude-code/tool-runtime/remoteControl.js'

export type BriefUploadContext = RemoteControlAttachmentContext

export function uploadBriefAttachment(
  fullPath: string,
  size: number,
  context: BriefUploadContext,
): Promise<string | undefined> {
  return uploadRemoteControlAttachment(fullPath, size, context)
}
