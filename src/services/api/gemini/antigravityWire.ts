/**
 * Antigravity wire adaptation for Gemini generateContent.
 *
 * The Antigravity backend speaks Gemini, but wrapped: the ordinary
 * generateContent body is nested under `request`, alongside routing fields the
 * IDE normally supplies (`model`, `project`, `requestType`, `requestId`,
 * `userAgent`). Responses come back with the ordinary GenerateContentResponse
 * nested under `response`. Everything downstream of this module — the stream
 * adapter, the message normaliser — is unchanged, which is the whole point of
 * keeping the wrapping here.
 *
 * Shapes verified against router-for-me/CLIProxyAPI:
 * `internal/runtime/executor/antigravity_executor_request.go` (geminiToAntigravity)
 * and `internal/translator/antigravity/gemini/antigravity_gemini_response.go`.
 *
 * Pure module: no I/O, no env reads beyond the base-URL override, so the
 * request shape is unit-testable without a network.
 */

import { createHash, randomUUID } from 'crypto'
import {
  ANTIGRAVITY_API_BASE_DAILY,
  ANTIGRAVITY_USER_AGENT,
} from 'src/services/auth/antigravity/constants.js'
import type {
  GeminiGenerateContentRequest,
  GeminiStreamChunk,
} from '@ant/model-provider'

const ANTIGRAVITY_STREAM_PATH = '/v1internal:streamGenerateContent'

/**
 * Base URL for Antigravity traffic. GEMINI_BASE_URL still wins so a user
 * fronting the backend with a proxy keeps working; otherwise the `daily-` host
 * the IDE itself prefers is used.
 */
export function getAntigravityBaseUrl(): string {
  const override = process.env.GEMINI_BASE_URL?.trim()
  return (override || ANTIGRAVITY_API_BASE_DAILY).replace(/\/+$/, '')
}

export function antigravityStreamUrl(): string {
  return `${getAntigravityBaseUrl()}${ANTIGRAVITY_STREAM_PATH}?alt=sse`
}

export function antigravityHeaders(
  accessToken: string,
): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    // The backend gates on this UA; a generic one is rejected as an
    // unrecognised client.
    'User-Agent': ANTIGRAVITY_USER_AGENT,
  }
}

/**
 * Session id the backend uses to group turns.
 *
 * Derived from the first user message so retries and follow-ups within one
 * conversation land on the same session, and so the value is deterministic in
 * tests. Format (leading '-' plus a 63-bit integer) matches what the IDE sends.
 */
export function deriveAntigravitySessionId(
  body: GeminiGenerateContentRequest,
): string {
  for (const content of body.contents ?? []) {
    if (content.role !== 'user') continue
    const parts = content.parts as Array<{ text?: string }> | undefined
    const text = parts?.find(part => typeof part.text === 'string')?.text
    if (!text) continue
    const digest = createHash('sha256').update(text).digest()
    // Mask the sign bit: the field is a signed 64-bit int on the wire.
    const value = digest.readBigUInt64BE(0) & 0x7fffffffffffffffn
    return `-${value.toString()}`
  }
  return `-${(BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))).toString()}`
}

export type AntigravityRequestEnvelope = {
  model: string
  project: string
  userAgent: string
  requestType: string
  /** Agent turns only — a web_search request carries no session identity. */
  requestId?: string
  request: Record<string, unknown>
}

/**
 * Request kinds the backend recognises. 'agent' is the tool-using chat turn;
 * 'web_search' is the grounded-search call WebSearch's Gemini source makes.
 */
export type AntigravityRequestType = 'agent' | 'web_search' | 'image_gen'

/**
 * Wrap a Gemini body into the Antigravity envelope.
 *
 * Two adjustments beyond the wrapping, both copied from the reference client:
 * safetySettings are dropped (the backend rejects them), and maxOutputTokens is
 * stripped for Gemini models — Antigravity caps output itself and 400s on a
 * client-supplied cap. Claude models served through Antigravity keep theirs.
 */
export function wrapAntigravityRequest(params: {
  model: string
  projectId: string
  body: GeminiGenerateContentRequest
  /** Injectable for deterministic tests. */
  requestId?: string
  sessionId?: string
  /**
   * Defaults to 'agent'. A 'web_search' request is a one-shot grounded query
   * with no conversation behind it, so it carries neither requestId nor
   * sessionId — the backend derives nothing from them there.
   */
  requestType?: AntigravityRequestType
}): AntigravityRequestEnvelope {
  const inner: Record<string, unknown> = { ...params.body }
  delete inner.safetySettings

  const isClaudeModel = params.model.toLowerCase().includes('claude')
  const generationConfig = inner.generationConfig
  if (
    !isClaudeModel &&
    generationConfig &&
    typeof generationConfig === 'object'
  ) {
    const trimmed = { ...(generationConfig as Record<string, unknown>) }
    delete trimmed.maxOutputTokens
    inner.generationConfig = trimmed
  }

  const requestType = params.requestType ?? 'agent'
  if (requestType === 'agent') {
    inner.sessionId =
      params.sessionId ?? deriveAntigravitySessionId(params.body)
  }

  return {
    model: params.model,
    project: params.projectId,
    userAgent: 'antigravity',
    requestType,
    ...(requestType === 'agent'
      ? { requestId: params.requestId ?? `agent-${randomUUID()}` }
      : {}),
    request: inner,
  }
}

/**
 * Unwrap one SSE payload. Frames that carry no `response` (keepalives, control
 * frames) yield null so the caller can skip them.
 */
export function unwrapAntigravityChunk(raw: unknown): GeminiStreamChunk | null {
  if (!raw || typeof raw !== 'object') return null
  const response = (raw as Record<string, unknown>).response
  if (!response || typeof response !== 'object') return null
  return response as GeminiStreamChunk
}
