/**
 * Merge cached upstream models into the built-in ModelPicker option list.
 *
 * Pure and dependency-free (leaf module — see cache.ts for why that matters).
 * The structural `MergeableModelOption` mirrors `ModelOption` from
 * `src/utils/model/modelOptions.ts` instead of importing it: importing the
 * type would close a modelOptions -> modelCatalog -> modelOptions loop that
 * the `check:cycles` ratchet counts even for `import type` edges.
 */

import type { CatalogModel } from './types.js'

export type MergeableModelOption = {
  value: string | null
  label: string
  description: string
  descriptionForModel?: string
}

/**
 * Ceiling on the merged list. The picker shows 10 rows at a time and reports
 * "and N more…"; past ~30 entries scrolling stops being a usable way to pick a
 * model. Built-ins are never dropped — only catalog entries are cut.
 */
export const MODEL_CATALOG_MAX_OPTIONS = 30

/**
 * Model ids that are not usable as a main-loop chat model. Provider model
 * lists are a catalog of *everything* the account can call — embeddings,
 * speech, image and moderation endpoints included — and dumping those into the
 * picker would bury the models a user actually wants.
 */
const NON_CHAT_ID_MARKERS = [
  'embed',
  'whisper',
  'tts',
  'text-to-speech',
  'speech',
  'audio',
  'transcribe',
  'realtime',
  'dall-e',
  'dalle',
  'imagen',
  'image',
  'veo',
  'moderation',
  'rerank',
  'similarity',
  'davinci',
  'babbage',
  'curie',
  'aqa',
] as const

/** Heuristic filter for ids that cannot serve a chat/completions turn. */
export function isLikelyChatModel(id: string): boolean {
  const normalized = id.toLowerCase()
  return !NON_CHAT_ID_MARKERS.some(marker => normalized.includes(marker))
}

/**
 * Dedup key. Built-in options carry the `[1m]` context suffix and differ in
 * case from what providers report, so both are normalized away — otherwise
 * `claude-opus-4-7[1m]` and `claude-opus-4-7` would both appear.
 */
function dedupKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '')
}

function toOption(model: CatalogModel): MergeableModelOption {
  const label = model.displayName?.trim() || model.id
  return {
    value: model.id,
    label,
    description:
      label === model.id
        ? 'Available from your provider'
        : `${model.id} · available from your provider`,
    descriptionForModel: `${label} (${model.id}) - reported by the provider's model list`,
  }
}

/**
 * Deterministic order for the appended block: newest first by the provider's
 * creation timestamp, ties broken by id. "Stable" here means input order never
 * leaks into the result — two refreshes of the same set render identically.
 */
function compareModels(a: CatalogModel, b: CatalogModel): number {
  const byCreated = (b.created ?? 0) - (a.created ?? 0)
  if (byCreated !== 0) return byCreated
  return a.id.localeCompare(b.id)
}

/**
 * Built-in options first, in their exact existing order; upstream models
 * appended after, deduped against the built-ins and each other, filtered to
 * chat-capable ids, sorted deterministically and capped at `maxTotal`.
 *
 * Returns the input array unchanged (a copy) when there is nothing to add, so
 * the default-selection logic downstream is unaffected.
 */
export function mergeCatalogModelOptions<T extends MergeableModelOption>(
  builtIn: readonly T[],
  catalog: readonly CatalogModel[] | null | undefined,
  options?: { maxTotal?: number },
): Array<T | MergeableModelOption> {
  const merged: Array<T | MergeableModelOption> = [...builtIn]
  if (!catalog || catalog.length === 0) return merged

  const maxTotal = options?.maxTotal ?? MODEL_CATALOG_MAX_OPTIONS
  const seen = new Set<string>()
  for (const option of builtIn) {
    if (option.value !== null) seen.add(dedupKey(option.value))
  }

  const candidates = catalog
    .filter(model => model.id.trim().length > 0 && isLikelyChatModel(model.id))
    .sort(compareModels)

  for (const model of candidates) {
    if (merged.length >= maxTotal) break
    const key = dedupKey(model.id)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(toOption(model))
  }
  return merged
}
