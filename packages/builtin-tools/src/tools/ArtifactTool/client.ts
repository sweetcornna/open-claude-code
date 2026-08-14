import { getArtifactsToken, getUploadUrl } from './config.js'
import { unauthorizedMessage, unreachableMessage } from './errors.js'
import type { ArtifactStore } from './store.js'

export type UploadResult = {
  id: string
  url: string
  expiresAt: string
}

export type UploadParams = {
  html: string
  token: string
  uploadUrl: string
  hash?: string
  ttl?: 7 | 30
}

export async function uploadArtifact(
  params: UploadParams,
): Promise<UploadResult> {
  const url = new URL(params.uploadUrl)
  if (params.hash) url.searchParams.set('hash', params.hash)
  if (params.ttl) url.searchParams.set('ttl', String(params.ttl))

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'text/html',
      },
      body: params.html,
    })
  } catch (e) {
    throw new Error(unreachableMessage(params.uploadUrl, e))
  }

  // Deno Deploy proxy flattens upstream status to 200; the Worker embeds the
  // real error in the body as `{ "error": "<code>" }`. Always parse body first.
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `Artifact upload failed: HTTP ${response.status} (non-JSON body)`,
    )
  }

  if (parsed && typeof parsed === 'object' && 'error' in parsed) {
    const code = String((parsed as { error: unknown }).error)
    // Every other code (payload_too_large, invalid_ttl, …) is already
    // actionable and passes through verbatim.
    if (code === 'unauthorized') throw new Error(unauthorizedMessage())
    throw new Error(`Artifact upload failed: ${code}`)
  }

  const data = parsed as Partial<UploadResult>
  if (
    typeof data.id !== 'string' ||
    typeof data.url !== 'string' ||
    typeof data.expiresAt !== 'string'
  ) {
    throw new Error(
      `Artifact upload returned malformed body: ${text.slice(0, 200)}`,
    )
  }
  return { id: data.id, url: data.url, expiresAt: data.expiresAt }
}

export const workerStore: ArtifactStore = {
  upload({ html, hash, ttlDays }) {
    return uploadArtifact({
      html,
      token: getArtifactsToken('worker'),
      uploadUrl: getUploadUrl(),
      hash,
      ttl: ttlDays,
    })
  },
}
