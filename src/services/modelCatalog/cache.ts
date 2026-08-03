/**
 * Disk cache for provider model lists.
 *
 * DELIBERATELY A LEAF MODULE. `src/utils/model/modelOptions.ts` imports this
 * on the ModelPicker path, so every import added here lands in the picker's
 * module graph — and, because modelOptions already sits inside several long
 * import chains, a new hop through this file would mint brand-new cycles for
 * the `check:cycles` ratchet to count. It therefore depends on nothing but
 * node builtins, `src/config/paths.ts` and `./types.ts`; failures are
 * swallowed rather than logged (no debug.ts import) and the API provider is
 * passed in as a plain string rather than imported from providers.ts.
 *
 * File: `<occ config dir>/model-catalog.json` — always via occConfigPath(),
 * never a hand-built `~/.occ` literal (see CLAUDE.md path invariants).
 */

import { randomBytes } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { occConfigPath } from 'src/config/paths.js'
import type {
  CatalogModel,
  ModelCatalogEntry,
  ModelCatalogFile,
} from './types.js'

export const MODEL_CATALOG_FILENAME = 'model-catalog.json'
export const MODEL_CATALOG_VERSION = 1
/** Upstream model lists move slowly; one refresh per day is plenty. */
export const MODEL_CATALOG_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Default endpoints per provider, mirroring the per-provider client modules
 * (`src/services/api/{openai,gemini,grok}/client.ts`). Duplicated rather than
 * imported to keep this module a leaf; the values are stable public endpoints.
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  firstParty: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  grok: 'https://api.x.ai/v1',
}

const BASE_URL_ENV_KEYS: Record<string, string> = {
  firstParty: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  gemini: 'GEMINI_BASE_URL',
  grok: 'GROK_BASE_URL',
}

/**
 * Resolve the model-list endpoint root for a provider, or null when the
 * provider has no OpenAI/Anthropic-style model list (bedrock, vertex,
 * foundry — those enumerate models through their cloud SDKs instead).
 */
export function resolveProviderBaseURL(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const fallback = DEFAULT_BASE_URLS[provider]
  if (!fallback) return null
  const envKey = BASE_URL_ENV_KEYS[provider]
  const configured = envKey ? env[envKey] : undefined
  const base = configured?.trim() || fallback
  return base.replace(/\/+$/, '')
}

/**
 * Cache key. Both halves matter: the same provider pointed at a different
 * gateway serves a different model list, and switching back should not show
 * the other endpoint's models.
 */
export function buildCatalogKey(provider: string, baseURL: string): string {
  return `${provider}|${baseURL.replace(/\/+$/, '').toLowerCase()}`
}

/** Convenience wrapper: key for a provider using the current environment. */
export function catalogKeyForProvider(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const baseURL = resolveProviderBaseURL(provider, env)
  return baseURL === null ? null : buildCatalogKey(provider, baseURL)
}

export function modelCatalogFilePath(): string {
  return occConfigPath(MODEL_CATALOG_FILENAME)
}

/**
 * Parsed-file memo. getModelOptions() runs on every ModelPicker render, so the
 * read must not hit the disk each time. Invalidated by writeModelCatalogEntry
 * (the background refresh runs in this same process) and by the test reset.
 */
let memoizedFile: { path: string; file: ModelCatalogFile | null } | null = null

function isCatalogModel(value: unknown): value is CatalogModel {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<CatalogModel>
  return typeof candidate.id === 'string' && candidate.id.length > 0
}

function parseCatalogFile(raw: string): ModelCatalogFile | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<ModelCatalogFile>
  if (candidate.version !== MODEL_CATALOG_VERSION) return null
  const rawEntries = candidate.entries
  if (typeof rawEntries !== 'object' || rawEntries === null) return null

  const entries: Record<string, ModelCatalogEntry> = {}
  for (const [key, value] of Object.entries(rawEntries)) {
    if (typeof value !== 'object' || value === null) continue
    const entry = value as Partial<ModelCatalogEntry>
    if (typeof entry.fetchedAt !== 'number') continue
    if (!Array.isArray(entry.models)) continue
    entries[key] = {
      fetchedAt: entry.fetchedAt,
      models: entry.models.filter(isCatalogModel),
    }
  }
  return { version: MODEL_CATALOG_VERSION, entries }
}

/**
 * Read and validate the catalog file. Returns null when missing, unreadable,
 * malformed or written by a different schema version — every one of which is
 * a normal "no cache yet" situation, never an error the user should see.
 */
export function readModelCatalogFile(): ModelCatalogFile | null {
  const path = modelCatalogFilePath()
  if (memoizedFile?.path === path) return memoizedFile.file
  let file: ModelCatalogFile | null = null
  try {
    file = parseCatalogFile(readFileSync(path, 'utf8'))
  } catch {
    file = null
  }
  memoizedFile = { path, file }
  return file
}

/**
 * Synchronous cached lookup used at ModelPicker build time. Returns null for
 * a missing or expired entry so callers fall back to the built-in list.
 */
export function getCachedModelCatalog(
  key: string | null,
  now: number = Date.now(),
): CatalogModel[] | null {
  if (!key) return null
  const entry = readModelCatalogFile()?.entries[key]
  if (!entry) return null
  if (now - entry.fetchedAt > MODEL_CATALOG_TTL_MS) return null
  return entry.models.length > 0 ? entry.models : null
}

/** Whether a fresh entry already exists — lets the refresh skip the network. */
export function hasFreshModelCatalog(
  key: string | null,
  now: number = Date.now(),
): boolean {
  return getCachedModelCatalog(key, now) !== null
}

/**
 * Persist one provider's models. Atomic (tmp file + rename) so a crash or a
 * concurrent occ process can never leave a half-written catalog behind.
 * Returns false on any failure — callers treat this as best-effort.
 */
export function writeModelCatalogEntry(
  key: string,
  models: readonly CatalogModel[],
  now: number = Date.now(),
): boolean {
  const path = modelCatalogFilePath()
  const existing = readModelCatalogFile()
  const next: ModelCatalogFile = {
    version: MODEL_CATALOG_VERSION,
    entries: {
      ...(existing?.entries ?? {}),
      [key]: { fetchedAt: now, models: [...models] },
    },
  }
  const tmpPath = `${path}.${randomBytes(6).toString('hex')}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(tmpPath, path)
  } catch {
    try {
      unlinkSync(tmpPath)
    } catch {
      // Nothing to clean up.
    }
    return false
  }
  memoizedFile = { path, file: next }
  return true
}

/** Drop the in-process parse memo. */
export function resetModelCatalogCache(): void {
  memoizedFile = null
}
