/**
 * Turning "this search source works right now" into a credential that keeps
 * working — the write half of /search-setting's pin action.
 *
 * The credential is captured from the environment rather than typed in. Two
 * reasons, and the second is the important one:
 *
 *   - Nothing has to be rendered. A TUI text field for an API key is a key on
 *     screen, in the scrollback, and in whatever the user's terminal logs.
 *   - The captured value is by construction the one the lane is already using,
 *     so a pin cannot silently differ from what the row was reporting as
 *     connected.
 *
 * MIRRORED VALUES ARE REFUSED. A provider-shaped env var does not mean that
 * provider's key: the DeepSeek wire copies the DeepSeek key onto
 * `ANTHROPIC_API_KEY`, and an OpenCode session mirrors an OAuth access token
 * onto `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` depending on its lane (CLAUDE.md
 * — that token expires within the hour and must never reach disk). Capturing
 * one would write another provider's secret into the search store under the
 * wrong name and then send it to that name's endpoint. All three are detected
 * through the mirrors' own bookkeeping predicates rather than by guessing at
 * the value's shape.
 */

import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { isOfficialOpenAIBaseURL } from 'src/services/api/openai/openaiShared.js'
import {
  getDeepSeekSearchEndpoint,
  isDeepSeekAnthropicWireActive,
  isDeepSeekMirroredApiKey,
} from 'src/utils/model/deepseekWire.js'
import {
  isOpencodeMirroredApiKey,
  isOpencodeMirroredOpenAIApiKey,
} from 'src/utils/model/opencodeWire.js'
import {
  isPinnableSearchSource,
  type PinnedSearchCredential,
} from './searchCredentialStore.js'

type SearchCredentialCapture =
  | { credential: PinnedSearchCredential }
  | { error: string }

function trimmedEnv(key: string): string | undefined {
  const value = process.env[key]?.trim()
  return value && value.length > 0 ? value : undefined
}

function captureAnthropic(): SearchCredentialCapture {
  // The DeepSeek routing points ANTHROPIC_BASE_URL at api.deepseek.com and
  // ANTHROPIC_API_KEY at the DeepSeek key. There is no Anthropic credential to
  // capture here, only a differently-named DeepSeek one — which the `deepseek`
  // row can pin properly.
  if (isDeepSeekAnthropicWireActive()) {
    return {
      error:
        'The Anthropic keys currently hold this session’s DeepSeek configuration. ' +
        'Pin the DeepSeek row instead.',
    }
  }
  const apiKey = trimmedEnv('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return {
      error:
        'No ANTHROPIC_API_KEY to pin. A Claude subscription login is an OAuth ' +
        'token this panel will not copy — set an API key for search, or leave ' +
        'this source following your login.',
    }
  }
  if (isDeepSeekMirroredApiKey(apiKey) || isOpencodeMirroredApiKey(apiKey)) {
    return {
      error:
        'ANTHROPIC_API_KEY currently holds another provider’s credential, ' +
        'mirrored there by this session. Refusing to pin it as Anthropic.',
    }
  }
  const baseURL = trimmedEnv('ANTHROPIC_BASE_URL')
  return { credential: { apiKey, ...(baseURL ? { baseURL } : {}) } }
}

function captureDeepSeek(): SearchCredentialCapture {
  // Deliberately the env derivation, not the pin-aware resolver: pinning must
  // capture what the environment is offering, or re-pinning an already-pinned
  // source would just copy the pin back over itself and quietly outlive a
  // configuration the user has since changed.
  const endpoint = getDeepSeekSearchEndpoint()
  if (!endpoint) {
    return {
      error:
        'No DeepSeek endpoint configured. Point OPENAI_BASE_URL at ' +
        'api.deepseek.com with a DeepSeek key, then pin.',
    }
  }
  return {
    credential: { apiKey: endpoint.apiKey, baseURL: endpoint.baseURL },
  }
}

function captureGemini(): SearchCredentialCapture {
  const apiKey = trimmedEnv('GEMINI_API_KEY')
  if (!apiKey) {
    return {
      error:
        'No GEMINI_API_KEY to pin. A Google login is an OAuth token this panel ' +
        'will not copy — set an API key for search to have one that survives ' +
        '/logout.',
    }
  }
  const baseURL = trimmedEnv('GEMINI_BASE_URL')
  return { credential: { apiKey, ...(baseURL ? { baseURL } : {}) } }
}

/**
 * The `codex` source is OpenAI's own server-side `web_search`, and only OpenAI
 * runs it — so the endpoint is captured under exactly the rule the credential
 * probe reads it back with. Pinning a key aimed at an OpenAI-COMPATIBLE gateway
 * would store the one credential shape that produces a green row and zero
 * results on every query: those endpoints accept the Responses request and even
 * run a search, but report neither `url_citation` annotations nor
 * `action.sources`.
 *
 * A stored ChatGPT login needs no pin: it is already a 0600 file of occ's own,
 * untouched by `/logout` and by `activateProfile()`. So there is nothing to
 * capture in that case, and the message says so rather than implying the
 * source is about to break.
 */
function captureCodex(): SearchCredentialCapture {
  const apiKey = trimmedEnv('OPENAI_API_KEY')
  if (!apiKey) {
    return {
      error:
        'No OPENAI_API_KEY to pin. A ChatGPT login is an OAuth token this ' +
        'panel will not copy — and it does not need pinning: it already lives ' +
        'in a file of occ’s own that /logout and provider switches leave alone.',
    }
  }
  // An OpenCode session on a GPT-family model mirrors its OAuth access token
  // onto OPENAI_API_KEY. That token is another provider's secret, expires
  // within the hour, and must never reach disk.
  if (isOpencodeMirroredOpenAIApiKey(apiKey)) {
    return {
      error:
        'OPENAI_API_KEY currently holds another provider’s credential, ' +
        'mirrored there by this session. Refusing to pin it as OpenAI.',
    }
  }
  const baseURL = trimmedEnv('OPENAI_BASE_URL')
  if (!isOfficialOpenAIBaseURL(baseURL)) {
    return {
      error:
        'OPENAI_BASE_URL does not point at api.openai.com, so this key belongs ' +
        'to that vendor and not to OpenAI — and only OpenAI runs the ' +
        'server-side web_search this source uses. Pinning it would light the ' +
        'row for a lane that returns nothing.',
    }
  }
  return { credential: { apiKey, ...(baseURL ? { baseURL } : {}) } }
}

/**
 * The credential a source is currently authenticating with, ready to pin, or
 * why there is nothing to capture.
 */
export function captureSearchCredentialFromEnvironment(
  family: SearchCredentialFamily,
): SearchCredentialCapture {
  if (!isPinnableSearchSource(family)) {
    return {
      error:
        'This source’s request layer has no credential seam, so a pinned key ' +
        'would never be sent.',
    }
  }
  switch (family) {
    case 'anthropic':
      return captureAnthropic()
    case 'codex':
      return captureCodex()
    case 'deepseek':
      return captureDeepSeek()
    case 'gemini':
      return captureGemini()
  }
}
