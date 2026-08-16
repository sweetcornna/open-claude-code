import axios from 'axios'
import { randomUUID } from 'crypto'
import { readFile } from 'fs/promises'
import { basename, extname } from 'path'
import { z } from 'zod/v4'
import type { RemoteControlAttachmentContext } from '@open-claude-code/tool-runtime/remoteControl.js'
import { getOauthConfig } from '../constants/oauth.js'
import { lazySchema } from '../utils/collections/lazySchema.js'
import { jsonStringify } from '../utils/telemetry/slowOperations.js'
import { logForDebugging } from '../utils/telemetry/debug.js'
import {
  getBridgeAccessToken,
  getBridgeBaseUrl,
  isSelfHostedBridge,
} from './bridgeConfig.js'

const MAX_UPLOAD_BYTES = 30 * 1024 * 1024
const UPLOAD_TIMEOUT_MS = 30_000
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
}

function guessMimeType(filename: string): string {
  return (
    MIME_BY_EXT[extname(filename).toLowerCase()] ?? 'application/octet-stream'
  )
}

function debug(message: string): void {
  logForDebugging(`[brief:upload] ${message}`)
}

/**
 * The upload has to go to whoever issued the token in `getBridgeAccessToken()`.
 * For every non-claude.ai bridge that is the bridge itself — falling through to
 * `ANTHROPIC_BASE_URL` there would hand an RCS access token to the user's
 * inference provider.
 */
function getUploadBaseUrl(): string {
  if (isSelfHostedBridge()) return getBridgeBaseUrl()
  return process.env.ANTHROPIC_BASE_URL ?? getOauthConfig().BASE_API_URL
}

const uploadResponseSchema = lazySchema(() =>
  z.object({ file_uuid: z.string() }),
)

export async function uploadBriefAttachment(
  fullPath: string,
  size: number,
  context: RemoteControlAttachmentContext,
): Promise<string | undefined> {
  if (!context.replBridgeEnabled) return undefined
  if (size > MAX_UPLOAD_BYTES) {
    debug(`skip ${fullPath}: ${size} bytes exceeds ${MAX_UPLOAD_BYTES} limit`)
    return undefined
  }

  const token = getBridgeAccessToken()
  if (!token) {
    debug('skip: no oauth token')
    return undefined
  }

  let content: Buffer
  try {
    content = await readFile(fullPath)
  } catch (error) {
    debug(`read failed for ${fullPath}: ${error}`)
    return undefined
  }

  const filename = basename(fullPath)
  const mimeType = guessMimeType(filename)
  const boundary = `----FormBoundary${randomUUID()}`
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])

  try {
    const response = await axios.post(
      `${getUploadBaseUrl()}/api/oauth/file_upload`,
      body,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length.toString(),
        },
        timeout: UPLOAD_TIMEOUT_MS,
        signal: context.signal,
        validateStatus: () => true,
      },
    )
    if (response.status !== 201) {
      debug(
        `upload failed for ${fullPath}: status=${response.status} body=${jsonStringify(response.data).slice(0, 200)}`,
      )
      return undefined
    }

    const parsed = uploadResponseSchema().safeParse(response.data)
    if (!parsed.success) {
      debug(
        `unexpected response shape for ${fullPath}: ${parsed.error.message}`,
      )
      return undefined
    }
    debug(`uploaded ${fullPath} → ${parsed.data.file_uuid} (${size} bytes)`)
    return parsed.data.file_uuid
  } catch (error) {
    debug(`upload threw for ${fullPath}: ${error}`)
    return undefined
  }
}
