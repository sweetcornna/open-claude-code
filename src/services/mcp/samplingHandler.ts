/**
 * MCP `sampling/createMessage` — servers requesting an LLM completion
 * through the client (2026-07-28 protocol; also present since 2024-11-05).
 *
 * Opt-in: the `sampling` capability is only advertised (and this handler
 * only registered) when `OCC_MCP_SAMPLING` is truthy. The spec says the
 * human SHOULD stay in the loop; until a per-request approval UI exists,
 * the loop is the env opt-in plus hard caps below — a server can never
 * spend tokens unless the operator explicitly enabled sampling.
 *
 * Caps: per-request `maxTokens` is clamped to MAX_TOKENS_CAP and each
 * session serves at most MAX_CALLS_PER_SESSION sampling calls across all
 * servers. Requests run on the small/fast model via sideQuery(), which
 * routes through whatever provider the session is configured for.
 *
 * v1 scope: text-only (image content blocks are skipped), no
 * CreateMessageResultWithTools (augmented tool calls) — a sampling result
 * never contains tool calls, which is valid per spec (tools in sampling
 * are a server request, not an obligation).
 */

import type { Client } from '@modelcontextprotocol/client'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages/messages.mjs'
import { isEnvTruthy } from '../../utils/config/envUtils.js'
import { getSmallFastModel } from '../../utils/model/model.js'
import { sideQuery } from '../../utils/session/sideQuery.js'
import { logMCPDebug, logMCPError } from '../../utils/telemetry/log.js'
import { logEvent } from '../analytics/index.js'

const MAX_TOKENS_CAP = 4096
const MAX_CALLS_PER_SESSION = 100

let samplingCallsThisSession = 0

/** Test hook — sessions never reset this in production. */
export function resetSamplingCallCount(): void {
  samplingCallsThisSession = 0
}

export function isMcpSamplingEnabled(): boolean {
  return isEnvTruthy(process.env.OCC_MCP_SAMPLING)
}

type SamplingContentBlock = {
  type?: string
  text?: string
}

type SamplingMessage = {
  role?: string
  content?: SamplingContentBlock | SamplingContentBlock[]
}

type CreateMessageParams = {
  messages?: SamplingMessage[]
  systemPrompt?: string
  maxTokens?: number
  temperature?: number
  stopSequences?: string[]
}

function toMessageParams(messages: SamplingMessage[]): MessageParam[] {
  const result: MessageParam[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const blocks = Array.isArray(message.content)
      ? message.content
      : message.content
        ? [message.content]
        : []
    const text = blocks
      .filter(block => block.type === 'text' && typeof block.text === 'string')
      .map(block => block.text)
      .join('\n')
    if (text) result.push({ role: message.role, content: text })
  }
  return result
}

function mapStopReason(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'maxTokens'
    case 'stop_sequence':
      return 'stopSequence'
    default:
      return 'endTurn'
  }
}

export function registerSamplingHandler(
  client: Client,
  serverName: string,
  // Injectable for tests only — mocking sideQuery/model modules process-wide
  // would pollute their own test files (see CLAUDE.md on mock.module).
  deps: {
    sampler?: typeof sideQuery
    resolveModel?: () => string
  } = {},
): void {
  if (!isMcpSamplingEnabled()) return
  const sampler = deps.sampler ?? sideQuery
  const resolveModel = deps.resolveModel ?? getSmallFastModel
  // Same defensive posture as the elicitation handler: setRequestHandler
  // throws when the client was constructed without the capability.
  try {
    client.setRequestHandler('sampling/createMessage', async (request, ctx) => {
      const params = (request.params ?? {}) as CreateMessageParams
      const { signal } = ctx.mcpReq

      if (samplingCallsThisSession >= MAX_CALLS_PER_SESSION) {
        throw new Error(
          `MCP sampling limit reached (${MAX_CALLS_PER_SESSION} calls per session)`,
        )
      }
      const messages = toMessageParams(params.messages ?? [])
      if (messages.length === 0) {
        throw new Error(
          'sampling/createMessage requires at least one text message',
        )
      }
      samplingCallsThisSession++

      const model = resolveModel()
      const maxTokens = Math.min(
        typeof params.maxTokens === 'number' && params.maxTokens > 0
          ? params.maxTokens
          : 1024,
        MAX_TOKENS_CAP,
      )
      logMCPDebug(
        serverName,
        `sampling/createMessage: ${messages.length} messages, max_tokens=${maxTokens} (call ${samplingCallsThisSession}/${MAX_CALLS_PER_SESSION})`,
      )
      logEvent('tengu_mcp_sampling_request', {})

      try {
        const response = await sampler({
          querySource: 'mcp_sampling',
          model,
          messages,
          ...(params.systemPrompt ? { system: params.systemPrompt } : {}),
          max_tokens: maxTokens,
          ...(typeof params.temperature === 'number'
            ? { temperature: params.temperature }
            : {}),
          ...(Array.isArray(params.stopSequences) &&
          params.stopSequences.length > 0
            ? { stop_sequences: params.stopSequences }
            : {}),
          signal,
          optional: true,
        })

        const text = response.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('')

        return {
          role: 'assistant',
          content: { type: 'text', text },
          model: response.model,
          stopReason: mapStopReason(response.stop_reason),
        }
      } catch (error) {
        logMCPError(
          serverName,
          `sampling/createMessage failed: ${String(error)}`,
        )
        throw error
      }
    })
  } catch (error) {
    logMCPDebug(serverName, `Sampling handler not registered: ${String(error)}`)
  }
}
