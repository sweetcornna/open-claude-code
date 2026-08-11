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
 * MIRRORED VALUES ARE REFUSED. `ANTHROPIC_API_KEY` is not always an Anthropic
 * key: the DeepSeek wire copies the DeepSeek key onto it, and an OpenCode
 * session mirrors an OAuth access token there (CLAUDE.md — that token expires
 * within the hour and must never reach disk). Capturing either would write
 * another provider's secret into the search store under Anthropic's name, and
 * then send it to api.anthropic.com. Both are detected through the mirrors' own
 * bookkeeping predicates rather than by guessing at the value's shape.
 */

import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import {
  getDeepSeekSearchEndpoint,
  isDeepSeekAnthropicWireActive,
  isDeepSeekMirroredApiKey,
} from 'src/utils/model/deepseekWire.js'
import { isOpencodeMirroredApiKey } from 'src/utils/model/opencodeWire.js'
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
 * The credential a source is currently authenticating with, ready to pin, or
 * why there is nothing to capture.
 */
export function captureSearchCredentialFromEnvironment(
  family: SearchCredentialFamily,
): SearchCredentialCapture {
  if (!isPinnableSearchSource(family)) {
    return {
      error:
        'This source authenticates inside the provider request layer, which ' +
        'reads OPENAI_* directly — a pinned key would never be sent. Log in ' +
        'with a ChatGPT account instead; that credential is a file of occ’s own.',
    }
  }
  switch (family) {
    case 'anthropic':
      return captureAnthropic()
    case 'deepseek':
      return captureDeepSeek()
    case 'gemini':
      return captureGemini()
    default:
      // Unreachable while PINNABLE_SEARCH_SOURCES holds the three above; kept
      // so adding a family to that list fails here loudly rather than pinning
      // an empty credential.
      return { error: `No capture rule for the ${family} search source.` }
  }
}
