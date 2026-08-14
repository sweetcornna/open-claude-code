import { randomUUID } from 'crypto'
import { getArtifactsBaseUrl, getArtifactsToken } from './config.js'
import { unauthorizedMessage, unreachableMessage } from './errors.js'
import type { ArtifactStore } from './store.js'

export const rustypasteStore: ArtifactStore = {
  async upload({ html, hash, ttlDays }) {
    if (hash) {
      throw new Error(
        'Custom artifact hashes are not supported by the rustypaste backend; omit hash or use OCC_ARTIFACTS_BACKEND=worker.',
      )
    }

    const form = new FormData()
    form.append(
      'file',
      new Blob([html], { type: 'text/html' }),
      `artifact-${randomUUID()}.html`,
    )

    const baseUrl = getArtifactsBaseUrl()
    // Read before the request so a missing token never costs a round trip.
    const token = getArtifactsToken('rustypaste')

    let response: Response
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: {
          // Rustypaste expects the upload token verbatim, unlike the Worker's
          // `Bearer <token>` authorization scheme.
          Authorization: token,
          expire: `${ttlDays}d`,
        },
        body: form,
      })
    } catch (e) {
      throw new Error(unreachableMessage(baseUrl, e))
    }
    const body = (await response.text()).trim()

    if (response.status === 401 || response.status === 403) {
      throw new Error(unauthorizedMessage())
    }
    if (!response.ok) {
      const detail = body ? `: ${body.slice(0, 200)}` : ''
      throw new Error(
        `Rustypaste artifact upload failed: HTTP ${response.status}${detail}`,
      )
    }

    let pasteUrl: URL
    try {
      pasteUrl = new URL(body)
    } catch {
      throw new Error(
        `Rustypaste artifact upload returned malformed URL: ${body.slice(0, 200)}`,
      )
    }

    const id = pasteUrl.pathname.split('/').filter(Boolean).at(-1)
    if (!id) {
      throw new Error(
        `Rustypaste artifact upload returned URL without a filename: ${body}`,
      )
    }

    return { id, url: body, expiresAt: undefined }
  },
}
