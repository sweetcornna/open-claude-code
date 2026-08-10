/**
 * Multi-lane search aggregation.
 *
 * The default WebSearch experience runs the current provider's OWN search
 * layer (Anthropic `api`, OpenAI `codex`, Gemini grounding) *plus* every
 * enabled extra source (keyless `free`, and any OAuth-connected provider
 * search) in parallel, then returns one merged list. The extra sources are
 * enhancements, not fallbacks: the official lane is authoritative and takes
 * rank 1, and the others contribute the pages it missed. Past rank 1 the lanes
 * interleave rather than draining in order — see mergeSearchLanes for why.
 *
 * Latency discipline — a scraping lane can be much slower than a provider API:
 *   - All lanes start at the same instant.
 *   - Once the primary lane returns results, the enhancers get a bounded
 *     grace period (ENHANCER_GRACE_MS) and are then dropped. A slow scrape
 *     costs the user a couple of seconds, never the whole search.
 *   - If the primary lane fails or comes back empty, the enhancers are
 *     awaited in full — with nothing to enhance, their results ARE the
 *     answer. This is the same code path, not a try/catch fallback: every
 *     lane is always launched, and the merge simply has fewer inputs.
 *   - Any single lane failing is silent. Only every lane failing surfaces an
 *     error to the tool.
 *
 * Abort is not a failure: an aborted signal propagates immediately so the
 * tool's cancellation path stays intact.
 *
 * Output contract is unchanged — plain SearchResult[], no lane attribution
 * field. Which backend found a URL is not something the model should reason
 * about.
 */

import { isAbortError } from '@open-claude-code/tool-runtime/errors.js'
import type { SearchOptions, SearchResult, WebSearchAdapter } from './types.js'
import { normalizeUrlForDedup } from './urlKey.js'

/** How long the enhancer may still run after the primary lane has landed. */
export const ENHANCER_GRACE_MS = 2_000

/** Mirrors the `num_results` default documented on the tool's input schema. */
const DEFAULT_RESULT_LIMIT = 8

interface LaneOutcome {
  results: SearchResult[]
  error?: unknown
}

interface RunningLane {
  outcome: Promise<LaneOutcome>
  abort(reason: unknown): void
}

async function runLane(
  adapter: WebSearchAdapter,
  query: string,
  options: SearchOptions,
): Promise<LaneOutcome> {
  try {
    return { results: await adapter.search(query, options) }
  } catch (error) {
    // Captured rather than thrown: a lane failing must not reject the other
    // lane's promise, and an unobserved rejection here would be an unhandled
    // rejection once we stop waiting for it.
    return { results: [], error }
  }
}

function startLane(
  adapter: WebSearchAdapter,
  query: string,
  options: SearchOptions,
): RunningLane {
  const controller = new AbortController()
  const parentSignal = options.signal
  const forwardParentAbort = (): void => controller.abort(parentSignal?.reason)
  if (parentSignal?.aborted) {
    forwardParentAbort()
  } else {
    parentSignal?.addEventListener('abort', forwardParentAbort, { once: true })
  }

  const outcome = runLane(adapter, query, {
    ...options,
    signal: controller.signal,
  }).finally(() => {
    parentSignal?.removeEventListener('abort', forwardParentAbort)
  })

  return {
    outcome,
    abort(reason) {
      controller.abort(reason)
    },
  }
}

async function withGrace(
  lane: RunningLane,
  graceMs: number,
): Promise<LaneOutcome | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => {
      resolve(undefined)
      lane.abort(new Error('Web search enhancer grace period expired'))
    }, graceMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([lane.outcome, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Interleave the lanes round-robin, in priority order within each round: lane 0
 * still owns rank 1, but every lane places its next-best hit before any lane
 * places its second. Dedup is by the stack-wide normalized URL, so campaign
 * parameters and trailing slashes do not smuggle the same page in twice.
 *
 * Round-robin rather than "drain lane 0, then lane 1, …" because the lanes do
 * not return the same KIND of thing, and the priority order is a panel order
 * (searchSources.ts) rather than a quality ranking. A provider grounding lane
 * returns the sources its model happened to cite while composing an answer —
 * domain-shaped titles, few hits, and whatever the answer wandered through;
 * the free lane returns an actually ranked SERP. Draining in order let a
 * grounding lane spend the whole `limit` and truncate the SERP lane away
 * entirely, which is how a search for "Zod v4 strictObject usage" returned six
 * GitHub issue threads and never `zod.dev/api?id=zstrictobject` — that page was
 * rank 1 of the lane that got cut.
 *
 * Interleaving keeps the "official lane is authoritative and ordered first"
 * contract (its top hit is still the overall top hit) while making it
 * impossible for any one lane to starve the others.
 */
export function mergeSearchLanes(
  lanes: SearchResult[][],
  limit: number,
): SearchResult[] {
  const merged: SearchResult[] = []
  const seen = new Set<string>()
  const cursors = lanes.map(() => 0)

  let placedThisRound = true
  while (merged.length < limit && placedThisRound) {
    placedThisRound = false
    for (const [laneIndex, lane] of lanes.entries()) {
      // Take this lane's next result that nobody has claimed yet, skipping
      // over the ones an earlier lane already placed.
      while ((cursors[laneIndex] as number) < lane.length) {
        const result = lane[cursors[laneIndex] as number]
        cursors[laneIndex] = (cursors[laneIndex] as number) + 1
        if (!result?.url) continue
        const key = normalizeUrlForDedup(result.url)
        if (!key || seen.has(key)) continue
        seen.add(key)
        merged.push({ ...result, url: key })
        placedThisRound = true
        break
      }
      if (merged.length >= limit) return merged
    }
  }

  return merged
}

export interface AggregateSearchOptions {
  /**
   * The current provider's own search layer. Optional: providers with no
   * server-side search (grok, bedrock, …) aggregate the enhancers alone.
   */
  primary?: WebSearchAdapter
  /** Extra sources, merged in order after the primary lane. */
  enhancers: WebSearchAdapter[]
  graceMs?: number
}

export class AggregateSearchAdapter implements WebSearchAdapter {
  private readonly primary?: WebSearchAdapter
  private readonly enhancers: WebSearchAdapter[]
  private readonly graceMs: number

  constructor(options: AggregateSearchOptions) {
    this.primary = options.primary
    this.enhancers = options.enhancers
    this.graceMs = options.graceMs ?? ENHANCER_GRACE_MS
  }

  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { onProgress } = options
    const limit = options.numResults ?? DEFAULT_RESULT_LIMIT

    // Only the primary lane drives the progress UI. Several lanes reporting
    // into one spinner would double-count and interleave unrelated query
    // updates; the aggregate result count is reported once, below.
    const primaryOptions: SearchOptions = {
      ...options,
      onProgress: progress => {
        if (progress.type === 'query_update') onProgress?.(progress)
      },
    }
    const enhancerOptions: SearchOptions = { ...options, onProgress: undefined }

    // Every lane is launched before anything is awaited — that concurrency is
    // the whole point.
    const primaryLane = this.primary
      ? startLane(this.primary, query, primaryOptions)
      : undefined
    const enhancerLanes = this.enhancers.map(enhancer =>
      startLane(enhancer, query, enhancerOptions),
    )

    const primaryOutcome = primaryLane ? await primaryLane.outcome : undefined
    const primaryError = primaryOutcome?.error
    if (isAbortError(primaryError)) {
      for (const lane of enhancerLanes) lane.abort(primaryError)
      throw primaryError
    }

    // With nothing from the primary lane there is nothing to enhance, so the
    // enhancers ARE the answer and get awaited in full. Same code path — the
    // merge just has fewer inputs.
    const hasPrimaryResults = (primaryOutcome?.results.length ?? 0) > 0
    const enhancerOutcomes = await Promise.all(
      enhancerLanes.map(lane =>
        hasPrimaryResults ? withGrace(lane, this.graceMs) : lane.outcome,
      ),
    )

    for (const outcome of enhancerOutcomes) {
      if (isAbortError(outcome?.error)) throw outcome?.error
    }

    const merged = mergeSearchLanes(
      [
        primaryOutcome?.results ?? [],
        ...enhancerOutcomes.map(outcome => outcome?.results ?? []),
      ],
      limit,
    )

    // Every lane that ran failed outright: surface the cause rather than an
    // empty list the model would read as "the web has no answer". A lane that
    // merely timed out is not a failure, so it does not count either way.
    const outcomes = [primaryOutcome, ...enhancerOutcomes].filter(
      (outcome): outcome is LaneOutcome => outcome !== undefined,
    )
    if (
      merged.length === 0 &&
      outcomes.length > 0 &&
      outcomes.every(outcome => outcome.error !== undefined)
    ) {
      throw outcomes[0]?.error
    }

    onProgress?.({
      type: 'search_results_received',
      resultCount: merged.length,
      query,
    })

    return merged
  }
}
