/**
 * Pinned web-search credentials — the one credential family `/logout` and
 * `/provider use` are not allowed to touch.
 *
 * WHY THIS EXISTS
 *
 * Every WebSearch source used to read its credential straight out of the
 * provider env: `GEMINI_API_KEY`, `OPENAI_API_KEY` + `OPENAI_BASE_URL`,
 * `ANTHROPIC_API_KEY`. Those are exactly the keys `/logout` deletes
 * (LOGOUT_ENV_KEYS, derived from ALL_PROFILE_ENV_KEYS) and the keys
 * `activateProfile()` clears wholesale before applying a target profile — it
 * wipes the union of EVERY family's keys, so merely switching from an OpenAI
 * profile to an OpenCode one takes the search credential with it.
 *
 * The result was silent: web search kept "working", having quietly degraded to
 * the keyless scraping lane, and nothing anywhere said why. Search is not part
 * of the account plane — a Gemini key held for grounding has nothing to do with
 * which provider runs the main loop — so it gets its own store, and that store
 * is deliberately outside everything the account plane rewrites.
 *
 * ISOLATION
 *
 * `occConfigPath()`, like every other occ credential file: never `~/.claude`,
 * never a bare `homedir()` join, so `OCC_CONFIG_DIR` moves it with everything
 * else. 0600 through `writePrivateFileAtomic` because the file holds raw API
 * keys — and deliberately NOT `settings.json`, which is world-readable-ish and
 * is the file users paste into bug reports.
 *
 * WHY NOT EVERY SOURCE CAN BE PINNED
 *
 * A pinned credential is only worth anything if the lane actually sends it, so
 * `PINNABLE_SEARCH_SOURCES` lists the sources whose request layer reads this
 * store. `codex` is absent: its lane authenticates inside
 * `src/services/api/openai/responsesAdapter.ts`, which builds the request from
 * `OPENAI_API_KEY`/`OPENAI_BASE_URL` directly and offers no credential seam.
 * Accepting a pin there would light the panel green for a key that is never
 * sent — the "connected source that can only return nothing" failure the whole
 * source registry exists to prevent (see searchSources.ts `isSourceEnabled`).
 * Its ChatGPT login is a 0600 file of its own, which is why the source has a
 * survivable credential at all.
 *
 * The READ side is uniform across all four families on purpose: enabling
 * `codex` later is a one-line addition here plus the credential seam in the
 * request layer, not a re-shape of the store.
 */

import type { SearchCredentialFamily } from '@open-claude-code/tool-runtime/searchCredentials.js'
import { readFileSync } from 'fs'
import { mkdir, unlink } from 'fs/promises'
import { occConfigDir, occConfigPath } from 'src/config/paths.js'
import { writePrivateFileAtomic } from 'src/utils/secureStorage/atomicWrite.js'

const SEARCH_CREDENTIALS_FILE = 'search-credentials.json'

const FILE_VERSION = 1

/**
 * Sources whose search lane reads this store, and which may therefore be
 * pinned. See the module header for why `codex` is not one of them.
 */
export const PINNABLE_SEARCH_SOURCES: readonly SearchCredentialFamily[] = [
  'anthropic',
  'deepseek',
  'gemini',
]

export function isPinnableSearchSource(
  family: SearchCredentialFamily,
): boolean {
  return PINNABLE_SEARCH_SOURCES.includes(family)
}

export type PinnedSearchCredential = {
  apiKey: string
  /**
   * Endpoint this key authenticates against.
   *
   * Stored rather than re-derived from env, because the env it would have been
   * derived from is the thing that goes away. It is also what keeps the
   * endpoint predicates honest: a key alone cannot tell `hasCodexSearch
   * Credentials()` whether it will reach OpenAI, and a DeepSeek key is
   * meaningless without the gateway host it belongs to.
   *
   * Optional: a family whose lane has a single well-known endpoint (Gemini's
   * public API) does not need one, and omitting it means "the default".
   */
  baseURL?: string
  /** ISO timestamp of the pin. For the panel — never the key itself. */
  pinnedAt?: string
}

type StoredEntry = {
  apiKey?: unknown
  baseURL?: unknown
  pinnedAt?: unknown
}

type StoredFile = {
  version?: unknown
  sources?: Record<string, StoredEntry | undefined>
}

export function searchCredentialsFilePath(): string {
  return occConfigPath(SEARCH_CREDENTIALS_FILE)
}

/**
 * Parsed file, memoized per resolved path.
 *
 * Memoized because `hasSearchCredentials()` is on the render path of
 * `/search-setting` (seven rows, every keystroke) and on every `createAdapter()`
 * call, and its contract is synchronous — so the alternative is a `readFileSync`
 * per row per render. Keyed by path so a test (or a user) swapping
 * `OCC_CONFIG_DIR` mid-process cannot read the previous root's answer.
 *
 * Writes through this module refresh the cache. An edit made to the file by
 * something else is picked up by `reloadPinnedSearchCredentials()`, which
 * `/search-setting`'s `R` (re-check) calls — the same key that already forgets
 * the session's other cached verdicts.
 */
let cache: {
  path: string
  sources: Map<string, PinnedSearchCredential>
} | null = null

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function parseEntry(
  entry: StoredEntry | undefined,
): PinnedSearchCredential | undefined {
  const apiKey = asNonEmptyString(entry?.apiKey)
  // No key, no credential. A record carrying only a base URL is not a partial
  // credential to be completed from env — mixing the two halves is how a pinned
  // endpoint would end up carrying whatever key the provider plane happened to
  // hold at the time.
  if (!apiKey) return undefined
  const baseURL = asNonEmptyString(entry?.baseURL)
  const pinnedAt = asNonEmptyString(entry?.pinnedAt)
  return {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(pinnedAt ? { pinnedAt } : {}),
  }
}

function loadSources(): Map<string, PinnedSearchCredential> {
  const path = searchCredentialsFilePath()
  if (cache?.path === path) return cache.sources

  const sources = new Map<string, PinnedSearchCredential>()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredFile | null
    for (const [family, entry] of Object.entries(parsed?.sources ?? {})) {
      const credential = parseEntry(entry)
      if (credential) sources.set(family, credential)
    }
  } catch {
    // Absent (the overwhelmingly common case), unreadable, or malformed. All
    // three mean "nothing pinned": this probe is contractually synchronous and
    // side-effect free, and a settings panel must not blow up on a stray file.
  }

  cache = { path, sources }
  return sources
}

/** The pinned credential for one source, or nothing. */
export function readPinnedSearchCredential(
  family: SearchCredentialFamily,
): PinnedSearchCredential | undefined {
  return loadSources().get(family)
}

/** Which sources currently hold a pinned credential. Never the values. */
export function listPinnedSearchSources(): SearchCredentialFamily[] {
  const sources = loadSources()
  return PINNABLE_SEARCH_SOURCES.filter(family => sources.has(family))
}

/** Forget the parsed file so the next read hits disk again. */
export function reloadPinnedSearchCredentials(): void {
  cache = null
}

function serialize(sources: Map<string, PinnedSearchCredential>): string {
  const record: Record<string, PinnedSearchCredential> = {}
  // Written in registry order rather than insertion order so the file does not
  // churn between writes.
  for (const family of PINNABLE_SEARCH_SOURCES) {
    const credential = sources.get(family)
    if (credential) record[family] = credential
  }
  return `${JSON.stringify({ version: FILE_VERSION, sources: record }, null, 2)}\n`
}

async function persist(
  sources: Map<string, PinnedSearchCredential>,
): Promise<void> {
  const path = searchCredentialsFilePath()
  await mkdir(occConfigDir(), { recursive: true })
  await writePrivateFileAtomic(path, serialize(sources))
  cache = { path, sources }
}

export class UnpinnableSearchSourceError extends Error {
  constructor(readonly family: SearchCredentialFamily) {
    super(
      `${family} cannot be pinned: its search lane authenticates through the ` +
        `provider request layer, so a pinned key would never be sent.`,
    )
    this.name = 'UnpinnableSearchSourceError'
  }
}

/**
 * Pin one source's credential, replacing whatever was pinned for it before.
 *
 * Rejects a source whose lane cannot read the store rather than storing a key
 * that would never leave the disk — see the module header.
 */
export async function pinSearchCredential(
  family: SearchCredentialFamily,
  credential: PinnedSearchCredential,
): Promise<void> {
  if (!isPinnableSearchSource(family)) {
    throw new UnpinnableSearchSourceError(family)
  }
  const apiKey = asNonEmptyString(credential.apiKey)
  if (!apiKey) {
    throw new Error(`Refusing to pin an empty ${family} credential.`)
  }
  const baseURL = asNonEmptyString(credential.baseURL)
  const sources = new Map(loadSources())
  sources.set(family, {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    pinnedAt: new Date().toISOString(),
  })
  await persist(sources)
}

/** Drop one source's pinned credential. Returns whether there was one. */
export async function unpinSearchCredential(
  family: SearchCredentialFamily,
): Promise<boolean> {
  const sources = new Map(loadSources())
  if (!sources.delete(family)) return false
  if (sources.size === 0) {
    // Nothing left to hold: remove the file rather than leaving an empty
    // credential store behind for a reader to wonder about.
    await unlink(searchCredentialsFilePath()).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
    cache = { path: searchCredentialsFilePath(), sources }
    return true
  }
  await persist(sources)
  return true
}
