/**
 * Background refresh of the provider model catalog.
 *
 * The ModelPicker's built-in option list is a hand-maintained table, so it
 * always lags whatever the upstream provider shipped last — worst on
 * third-party / OpenAI-compatible endpoints, where the useful model ids are
 * not Anthropic's at all. This job asks the active provider for its model list
 * once a session, caches it to disk, and `getModelOptions()` appends the
 * result. Nothing here is on a user-visible path: it fires several seconds
 * after startup on an unref'd timer, is capped at one run per session, and
 * every failure is a `logForDebugging` line.
 *
 * Mounted the same way as `backgroundOccUpdate.ts` — a dynamic import from
 * rootAction's interactive tail, so the print path never pays for it — and
 * injectable through the same `deps` seam, so tests drive the whole flow
 * without process-global `mock.module` calls.
 */

import { isEssentialTrafficOnly } from 'src/utils/auth/privacyLevel.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { logForDebugging } from 'src/utils/telemetry/debug.js'
import {
  catalogKeyForProvider,
  hasFreshModelCatalog,
  writeModelCatalogEntry,
} from './cache.js'
import { fetchProviderModels } from './fetch.js'
import type { CatalogModel } from './types.js'

/** Hard ceiling on the request. A slow provider must not hold a socket open. */
export const MODEL_CATALOG_FETCH_TIMEOUT_MS = 5_000
/** Far enough past startup that it never competes with the first turn. */
const REFRESH_DELAY_MS = 8_000

export type RefreshModelCatalogDeps = {
  getProvider: () => string
  isEssentialTrafficOnly: () => boolean
  hasFreshCatalog: (key: string, now: number) => boolean
  fetchModels: (
    provider: string,
    options: { signal: AbortSignal },
  ) => Promise<CatalogModel[] | null>
  writeEntry: (
    key: string,
    models: readonly CatalogModel[],
    now: number,
  ) => boolean
}

function defaultDeps(fetchImpl?: typeof fetch): RefreshModelCatalogDeps {
  return {
    getProvider: () => getAPIProvider(),
    isEssentialTrafficOnly,
    hasFreshCatalog: hasFreshModelCatalog,
    fetchModels: (provider, options) =>
      fetchProviderModels(provider, {
        signal: options.signal,
        ...(fetchImpl ? { fetchImpl } : {}),
      }),
    writeEntry: writeModelCatalogEntry,
  }
}

export type RefreshModelCatalogResult =
  | { status: 'skipped'; reason: string }
  | { status: 'fresh' }
  | { status: 'fetch-failed' }
  | { status: 'write-failed' }
  | { status: 'updated'; models: CatalogModel[] }

export type RefreshModelCatalogOptions = {
  /** Refresh even when the cached entry is still inside its TTL. */
  force?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
  now?: number
  deps?: RefreshModelCatalogDeps
}

/**
 * One refresh pass. Never throws; every failure downgrades to a status the
 * tests can assert on plus a debug log line.
 */
export async function refreshModelCatalog(
  options: RefreshModelCatalogOptions = {},
): Promise<RefreshModelCatalogResult> {
  try {
    const deps = options.deps ?? defaultDeps(options.fetchImpl)

    if (deps.isEssentialTrafficOnly()) {
      return {
        status: 'skipped',
        reason: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      }
    }
    const provider = deps.getProvider()
    const key = catalogKeyForProvider(provider)
    if (!key) {
      return { status: 'skipped', reason: `unsupported provider: ${provider}` }
    }
    const now = options.now ?? Date.now()
    if (!options.force && deps.hasFreshCatalog(key, now)) {
      logForDebugging(`[ModelCatalog] ${provider}: cache still fresh`)
      return { status: 'fresh' }
    }

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? MODEL_CATALOG_FETCH_TIMEOUT_MS,
    )
    let models: CatalogModel[] | null
    try {
      models = await deps.fetchModels(provider, { signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!models || models.length === 0) {
      return { status: 'fetch-failed' }
    }

    if (!deps.writeEntry(key, models, now)) {
      return { status: 'write-failed' }
    }
    logForDebugging(
      `[ModelCatalog] ${provider}: cached ${models.length} models`,
    )
    return { status: 'updated', models }
  } catch (error) {
    // fetchProviderModels swallows its own failures; this guards the
    // surrounding bookkeeping so a session can never see a rejection.
    logForDebugging(`[ModelCatalog] refresh failed: ${error}`)
    return { status: 'fetch-failed' }
  }
}

let scheduledThisSession = false

/**
 * Schedule the once-per-session refresh. Cheap env guards run here so no timer
 * is created in the disabled cases; refreshModelCatalog re-checks everything
 * when it fires. Returns whether a run was scheduled.
 */
export function maybeScheduleModelCatalogRefresh(options?: {
  env?: NodeJS.ProcessEnv
  delayMs?: number
  run?: () => Promise<unknown>
}): boolean {
  if (scheduledThisSession) return false
  const env = options?.env ?? process.env
  if (env.NODE_ENV === 'test') return false
  if (env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return false

  scheduledThisSession = true
  const run = options?.run ?? (() => refreshModelCatalog())
  const timer = setTimeout(() => {
    void run().catch(error => {
      logForDebugging(`[ModelCatalog] scheduled run failed: ${error}`)
    })
  }, options?.delayMs ?? REFRESH_DELAY_MS)
  // Never keep the process alive just to refresh a picker list.
  timer.unref()
  return true
}

export function resetModelCatalogScheduleForTests(): void {
  scheduledThisSession = false
}
