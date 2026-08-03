/**
 * Shape of the on-disk model catalog. Kept in its own leaf module so both the
 * synchronous cache reader (loaded on the ModelPicker path) and the async
 * fetcher (loaded only by the background refresh) can share it without either
 * pulling the other's dependencies in.
 */

/** One model as reported by a provider's model-list endpoint. */
export type CatalogModel = {
  /** Provider model id, used verbatim as the ModelPicker option value. */
  id: string
  /** Human name when the provider reports one (Anthropic/Gemini do). */
  displayName?: string
  /** Provider creation timestamp in unix seconds, when reported. */
  created?: number
}

/** One provider+baseURL slot in the catalog file. */
export type ModelCatalogEntry = {
  /** Unix ms when this entry was written. Drives the TTL check. */
  fetchedAt: number
  models: CatalogModel[]
}

export type ModelCatalogFile = {
  version: number
  /** Keyed by `buildCatalogKey(provider, baseURL)`. */
  entries: Record<string, ModelCatalogEntry>
}
