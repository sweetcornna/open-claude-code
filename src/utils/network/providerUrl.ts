export type ProviderURLKind =
  | 'anthropic'
  | 'openai'
  | 'gemini'
  | 'antigravity'
  | 'deepseek'
  | 'deepseekAnthropic'

type SplitProviderBaseURL = {
  baseURL: string
  defaultQuery?: Record<string, string | undefined>
}

const ANTHROPIC_RESOURCE_SUFFIX = /\/v1\/(?:messages|models|files)(?:\/.*)?$/i
const OPENAI_RESOURCE_SUFFIX = /\/(?:chat\/completions|responses)$/i
/** `…/models/gpt-5` — naming a model can only ever be a resource, not a base. */
const OPENAI_MODEL_RESOURCE_SUFFIX = /\/models\/[^/]+$/i
/**
 * A bare trailing `models` is the list endpoint ONLY directly behind a version
 * segment (`/v1/models`, `/v1beta/models`).
 *
 * Anywhere else it is somebody's proxy path — `https://gw.example/zen/models`
 * routes a whole deployment — and swallowing it silently retargets every
 * request at `https://gw.example/zen`, which is the one thing this module
 * promises not to do.
 */
const OPENAI_MODEL_LIST_PATH = /^(.*\/v\d+[a-z]*\d*)\/models$/i
const GEMINI_RESOURCE_SUFFIX = /\/models(?:\/.*)?$/i
const ANTIGRAVITY_RESOURCE_SUFFIX =
  /\/v1internal(?::(?:stream)?generateContent)?$/i
const VERSION_SUFFIX = /\/v1$/i
const DEEPSEEK_ANTHROPIC_SUFFIX = /\/anthropic$/i

function stripTrailingSlashes(pathname: string): string {
  const stripped = pathname.replace(/\/+$/, '')
  return stripped || '/'
}

function stripSuffix(pathname: string, suffix: RegExp): string {
  return stripTrailingSlashes(pathname.replace(suffix, ''))
}

function stripOpenAIResource(pathname: string): string {
  let normalized = stripSuffix(pathname, OPENAI_RESOURCE_SUFFIX)
  normalized = stripSuffix(normalized, OPENAI_MODEL_RESOURCE_SUFFIX)
  const versionedList = normalized.match(OPENAI_MODEL_LIST_PATH)?.[1]
  return versionedList ? stripTrailingSlashes(versionedList) : normalized
}

function normalizePathname(pathname: string, kind: ProviderURLKind): string {
  let normalized = stripTrailingSlashes(pathname)

  if (
    kind === 'anthropic' ||
    kind === 'deepseek' ||
    kind === 'deepseekAnthropic'
  ) {
    normalized = stripSuffix(normalized, ANTHROPIC_RESOURCE_SUFFIX)
    normalized = stripSuffix(normalized, VERSION_SUFFIX)
  }
  if (
    kind === 'openai' ||
    kind === 'deepseek' ||
    kind === 'deepseekAnthropic'
  ) {
    normalized = stripOpenAIResource(normalized)
  }
  if (kind === 'gemini') {
    normalized = stripSuffix(normalized, GEMINI_RESOURCE_SUFFIX)
  }
  if (kind === 'antigravity') {
    normalized = stripSuffix(normalized, ANTIGRAVITY_RESOURCE_SUFFIX)
  }
  if (kind === 'deepseek' || kind === 'deepseekAnthropic') {
    normalized = stripSuffix(normalized, VERSION_SUFFIX)
    normalized = stripSuffix(normalized, DEEPSEEK_ANTHROPIC_SUFFIX)
    normalized = stripSuffix(normalized, VERSION_SUFFIX)
    if (kind === 'deepseekAnthropic') {
      normalized = `${normalized === '/' ? '' : normalized}/anthropic`
    }
  }

  return normalized
}

function serializeBaseURL(url: URL): string {
  const serialized = url.toString()
  if (url.pathname !== '/') return serialized
  const suffix = `/${url.search}`
  return serialized.endsWith(suffix)
    ? `${serialized.slice(0, -suffix.length)}${url.search}`
    : serialized
}

/**
 * Canonicalize a provider base URL without ever treating its query or fragment
 * as pathname text. Known terminal API resources are reduced to the base each
 * provider client expects; proxy path prefixes and query values are preserved.
 */
export function normalizeProviderBaseURL(
  baseURL: string,
  kind: ProviderURLKind,
): string {
  const url = new URL(baseURL.trim())
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('Provider base URL must use http or https')
  }
  const query = new URLSearchParams()
  for (const [key, value] of url.searchParams) query.set(key, value)
  url.pathname = normalizePathname(url.pathname, kind)
  url.search = query.toString()
  url.hash = ''
  return serializeBaseURL(url)
}

/** Split a canonical base into the fields accepted by provider SDK clients. */
export function splitProviderBaseURL(
  baseURL: string,
  kind: ProviderURLKind,
): SplitProviderBaseURL {
  const url = new URL(normalizeProviderBaseURL(baseURL, kind))
  const defaultQuery: Record<string, string | undefined> = {}
  for (const [key, value] of url.searchParams) defaultQuery[key] = value
  url.search = ''
  return {
    baseURL: serializeBaseURL(url),
    ...(Object.keys(defaultQuery).length > 0 ? { defaultQuery } : {}),
  }
}

/** Append one provider resource while preserving the base URL's query params. */
export function buildProviderResourceURL(
  baseURL: string,
  kind: ProviderURLKind,
  resourcePath: string,
  query: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(normalizeProviderBaseURL(baseURL, kind))
  const basePath = url.pathname === '/' ? '' : url.pathname
  url.pathname = `${basePath}/${resourcePath.replace(/^\/+/, '')}`
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  return url.toString()
}
