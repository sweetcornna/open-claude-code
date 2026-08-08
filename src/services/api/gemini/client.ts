import { parseSSEFrames } from 'src/cli/transports/SSETransport.js'
import { getValidAntigravityAuth } from 'src/services/auth/antigravity/oauth.js'
import { errorMessage } from 'src/utils/runtime/errors.js'
import { isAntigravityAuthMode } from 'src/utils/model/antigravityModels.js'
import { getProxyFetchOptions } from 'src/utils/network/proxy.js'
import { buildProviderResourceURL } from 'src/utils/network/providerUrl.js'
import {
  antigravityHeaders,
  antigravityStreamUrl,
  unwrapAntigravityChunk,
  wrapAntigravityRequest,
  type AntigravityRequestType,
} from './antigravityWire.js'
import { hasGeminiOAuthCredentialsSync } from './oauthToken.js'
import type {
  GeminiGenerateContentRequest,
  GeminiStreamChunk,
} from '@ant/model-provider'

const DEFAULT_GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta'

const STREAM_DECODE_OPTS: TextDecodeOptions = { stream: true }

function getGeminiModelPath(model: string): string {
  const normalized = model.replace(/^\/+/, '')
  return normalized.startsWith('models/') ? normalized : `models/${normalized}`
}

/**
 * Where and how one generateContent stream goes out.
 *
 * The Antigravity backend differs from the public Gemini API in every field —
 * URL, auth header, body envelope, and where the payload sits inside a frame —
 * so the four are resolved together instead of being patched onto each other.
 * `unwrapChunk` returning null means "skip this frame".
 */
type GeminiWireRequest = {
  url: string
  headers: Record<string, string>
  body: unknown
  unwrapChunk: (raw: unknown) => GeminiStreamChunk | null
}

class GeminiRequestError extends Error {
  readonly status: number
  readonly headers: Headers

  constructor(message: string, response: Response) {
    super(message)
    this.name = 'GeminiRequestError'
    this.status = response.status
    this.headers = response.headers
  }
}

/**
 * Whether a call with these options will go out over Antigravity rather than
 * the public Gemini endpoint.
 *
 * Exported because the choice is not merely transport: the two backends serve
 * DIFFERENT MODEL CATALOGUES. Antigravity knows `gemini-3.1-flash-lite` and
 * friends and answers anything else with a bare 404 "Requested entity was not
 * found", so a caller picking a default model has to know which one it is
 * talking to. Callers must not re-derive this condition by hand.
 *
 * An explicit accessToken means the caller already picked its endpoint and
 * credential: honour it verbatim rather than rerouting it through Antigravity's
 * envelope.
 *
 * `useAntigravityWhenAvailable` is for callers that are not the main loop —
 * WebSearch's Gemini source runs even when the session talks to another
 * provider, so "am I in Antigravity mode" is the wrong question there; "is
 * there a Google login" is the right one.
 */
export function usesAntigravityRoute(params: {
  accessToken?: string
  useAntigravityWhenAvailable?: boolean
}): boolean {
  return (
    !params.accessToken &&
    (isAntigravityAuthMode() ||
      (params.useAntigravityWhenAvailable === true &&
        hasGeminiOAuthCredentialsSync()))
  )
}

async function resolveGeminiWireRequest(params: {
  model: string
  body: GeminiGenerateContentRequest
  accessToken?: string
  requestType?: AntigravityRequestType
  useAntigravityWhenAvailable?: boolean
}): Promise<GeminiWireRequest> {
  if (usesAntigravityRoute(params)) {
    const auth = await getValidAntigravityAuth()
    return {
      url: antigravityStreamUrl(),
      headers: antigravityHeaders(auth.accessToken),
      body: wrapAntigravityRequest({
        model: params.model,
        projectId: auth.projectId,
        body: params.body,
        ...(params.requestType ? { requestType: params.requestType } : {}),
      }),
      unwrapChunk: unwrapAntigravityChunk,
    }
  }
  return {
    url: buildProviderResourceURL(
      process.env.GEMINI_BASE_URL || DEFAULT_GEMINI_BASE_URL,
      'gemini',
      `${getGeminiModelPath(params.model)}:streamGenerateContent`,
      { alt: 'sse' },
    ),
    headers: {
      'Content-Type': 'application/json',
      ...(params.accessToken
        ? { Authorization: `Bearer ${params.accessToken}` }
        : { 'x-goog-api-key': process.env.GEMINI_API_KEY || '' }),
    },
    body: params.body,
    unwrapChunk: raw => raw as GeminiStreamChunk,
  }
}

export async function* streamGeminiGenerateContent(params: {
  model: string
  body: GeminiGenerateContentRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  /**
   * OAuth bearer token. When supplied it REPLACES the `x-goog-api-key` header
   * — Google rejects a request carrying both. Used by the OAuth-connected
   * Gemini search source, where there is no GEMINI_API_KEY at all.
   */
  accessToken?: string
  /**
   * Antigravity request kind. Defaults to 'agent'; WebSearch's Gemini source
   * sends 'web_search'. Ignored on the public Gemini endpoint, which has no
   * envelope.
   */
  requestType?: AntigravityRequestType
  /**
   * Route through Antigravity whenever a Google login exists, even if the main
   * loop is not in Antigravity mode. For callers that are not the main loop.
   */
  useAntigravityWhenAvailable?: boolean
}): AsyncGenerator<GeminiStreamChunk, void> {
  const fetchImpl = params.fetchOverride ?? fetch
  const wire = await resolveGeminiWireRequest({
    model: params.model,
    body: params.body,
    ...(params.accessToken ? { accessToken: params.accessToken } : {}),
    ...(params.requestType ? { requestType: params.requestType } : {}),
    ...(params.useAntigravityWhenAvailable
      ? { useAntigravityWhenAvailable: true }
      : {}),
  })
  const { url, unwrapChunk } = wire

  const response = await fetchImpl(url, {
    method: 'POST',
    headers: wire.headers,
    body: JSON.stringify(wire.body),
    signal: params.signal,
    ...getProxyFetchOptions({ forAnthropicAPI: false }),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new GeminiRequestError(
      `Gemini API request failed (${response.status} ${response.statusText}): ${body || 'empty response body'}`,
      response,
    )
  }

  if (!response.body) {
    throw new Error('Gemini API returned no response body')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, STREAM_DECODE_OPTS)
      const { frames, remaining } = parseSSEFrames(buffer)
      buffer = remaining

      for (const frame of frames) {
        if (!frame.data || frame.data === '[DONE]') continue
        let parsed: unknown
        try {
          parsed = JSON.parse(frame.data)
        } catch (error) {
          throw new Error(
            `Failed to parse Gemini SSE payload: ${errorMessage(error)}`,
          )
        }
        const chunk = unwrapChunk(parsed)
        if (chunk) yield chunk
      }
    }

    buffer += decoder.decode()
    const { frames } = parseSSEFrames(buffer)
    for (const frame of frames) {
      if (!frame.data || frame.data === '[DONE]') continue
      let parsed: unknown
      try {
        parsed = JSON.parse(frame.data)
      } catch (error) {
        throw new Error(
          `Failed to parse trailing Gemini SSE payload: ${errorMessage(error)}`,
        )
      }
      const chunk = unwrapChunk(parsed)
      if (chunk) yield chunk
    }
  } finally {
    reader.releaseLock()
  }
}
