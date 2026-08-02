/**
 * Wire-protocol selection for the OpenAI-compatible path.
 *
 * Two wire protocols reach OpenAI-compatible endpoints:
 *  - 'chat'      — Chat Completions (`/chat/completions`), the long-standing
 *                  default that every compatible provider speaks.
 *  - 'responses' — the Responses API (`/responses`), OpenAI's item-based
 *                  protocol with typed SSE events and first-class reasoning.
 *
 * Resolution order:
 *  1. `OPENAI_WIRE_API` env — explicit `chat` / `responses` wins outright.
 *  2. ChatGPT-subscription auth (`OPENAI_AUTH_MODE=chatgpt`) forces
 *     'responses': the Codex backend it talks to has no Chat Completions.
 *  3. Default 'chat' — compatible providers (Ollama/vLLM/DeepSeek/...) are
 *     not assumed to implement `/responses`.
 */

import { isChatGPTAuthEnabled } from './chatgptAuth.js'

export type OpenAIWireProtocol = 'chat' | 'responses'

export function resolveOpenAIWireProtocol(): OpenAIWireProtocol {
  const explicit = process.env.OPENAI_WIRE_API?.trim().toLowerCase()
  if (explicit === 'responses') return 'responses'
  if (explicit === 'chat') return 'chat'
  if (isChatGPTAuthEnabled()) return 'responses'
  return 'chat'
}
