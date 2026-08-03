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
 *  3. Codex-family model (id contains 'codex', or the GPT-5 generation —
 *     see isCodexFamilyModel) defaults to 'responses': OpenAI serves these
 *     models Responses-first. `OPENAI_WIRE_API=chat` remains the escape
 *     hatch for compatible providers that reuse such ids without
 *     implementing `/responses`.
 *  4. Default 'chat' — compatible providers (Ollama/vLLM/DeepSeek/...) are
 *     not assumed to implement `/responses`.
 */

import { isCodexFamilyModel } from '../../../utils/model/chatgptModels.js'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'

export type OpenAIWireProtocol = 'chat' | 'responses'

/**
 * @param model - The resolved OpenAI model id (post resolveOpenAIModel).
 *   Optional for backward compatibility; when omitted, the Codex-family
 *   default (tier 3) is skipped.
 */
export function resolveOpenAIWireProtocol(model?: string): OpenAIWireProtocol {
  const explicit = process.env.OPENAI_WIRE_API?.trim().toLowerCase()
  if (explicit === 'responses') return 'responses'
  if (explicit === 'chat') return 'chat'
  if (isChatGPTAuthEnabled()) return 'responses'
  if (model !== undefined && isCodexFamilyModel(model)) return 'responses'
  return 'chat'
}
