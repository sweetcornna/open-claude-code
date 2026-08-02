/**
 * What it costs to keep the message lookups up to date while a conversation
 * grows.
 *
 * `buildMessageLookups` walks both message arrays and allocates eight
 * Maps/Sets. Doing that on every render is O(n) per message and O(n²) over a
 * session, which is why Messages.tsx caches the lookups and updates them in
 * place. This measures whether that actually happens, by replaying a synthetic
 * agentic loop (tool call -> progress -> tool result) one message at a time
 * under three policies:
 *
 *   rebuild  - no cache at all; the honest baseline.
 *   legacy   - the policy before this change: structure-key cache, an
 *              append check based only on array lengths, and a rebuild
 *              whenever the trailing assistant message id changed.
 *   current  - resolveMessageLookups.
 *
 * `legacy` calls today's updater, so the numbers isolate the change in *when*
 * the fast path is taken, not the updater's internals.
 *
 * Run:
 *   bun run scripts/bench-message-lookups.ts [turns] [repeats]
 */
import {
  assistantToolUse,
  fixtureUuid,
  progressTick,
  userText,
  userToolResult,
} from '../tests/mocks/fixtures/conversation.js'
import type { AssistantMessage, Message } from '../src/types/message.js'
import {
  buildMessageLookups,
  computeMessageStructureKey,
  type MessageLookups,
  type MessageLookupsCache,
  resolveMessageLookups,
  updateMessageLookupsIncremental,
} from '../src/utils/messages/lookups.js'

type Step = {
  /** Appended to the normalized array (progress entries included). */
  normalized: Message
  /** Also appended to the shown array — Messages.tsx drops progress. */
  shown: boolean
}

/** One user turn, then `turns` iterations of tool call / progress / result. */
function conversation(turns: number): Step[] {
  const steps: Step[] = [
    { normalized: userText(fixtureUuid(1), 'go'), shown: true },
  ]
  for (let turn = 0; turn < turns; turn++) {
    const base = 10 + turn * 3
    const toolUseID = `toolu_${turn}`
    steps.push(
      {
        normalized: assistantToolUse(
          { messageId: `msg_${turn}`, uuid: fixtureUuid(base) },
          [{ id: toolUseID, name: 'Bash', input: { command: 'ls' } }],
        ),
        shown: true,
      },
      {
        normalized: progressTick(fixtureUuid(base + 1), toolUseID),
        shown: false,
      },
      {
        normalized: userToolResult(fixtureUuid(base + 2), toolUseID, 'ok'),
        shown: true,
      },
    )
  }
  return steps
}

type Tally = {
  cached: number
  incremental: number
  rebuild: number
  /**
   * Sum of the step indices at which a rebuild happened. A rebuild at step i
   * touches i messages, so this weights each one by its actual size instead of
   * pretending they all cost as much as the last.
   */
  rebuildStepSum: number
}

function emptyTally(): Tally {
  return { cached: 0, incremental: 0, rebuild: 0, rebuildStepSum: 0 }
}

function replayRebuildOnly(steps: Step[]): Tally {
  const normalized: Message[] = []
  const shown: Message[] = []
  const tally = emptyTally()
  for (const [index, step] of steps.entries()) {
    normalized.push(step.normalized)
    if (step.shown) shown.push(step.normalized)
    buildMessageLookups(normalized, shown)
    tally.rebuild++
    tally.rebuildStepSum += index
  }
  return tally
}

type LegacyCache = {
  key: string
  lookups: MessageLookups
  normalizedCount: number
  messageCount: number
  lastAssistantMsgId: string | undefined
}

function replayLegacy(steps: Step[]): Tally {
  const normalized: Message[] = []
  const shown: Message[] = []
  const tally = emptyTally()
  let cache: LegacyCache | null = null

  for (const [index, step] of steps.entries()) {
    normalized.push(step.normalized)
    if (step.shown) shown.push(step.normalized)

    const key = computeMessageStructureKey(normalized, shown)
    if (cache && cache.key === key) {
      tally.cached++
      continue
    }

    const lastMsg = shown.at(-1)
    const lastAssistantMsgId =
      lastMsg?.type === 'assistant'
        ? (lastMsg as AssistantMessage).message?.id
        : undefined

    let updated: MessageLookups | null = null
    if (
      cache &&
      normalized.length >= cache.normalizedCount &&
      shown.length >= cache.messageCount &&
      cache.lastAssistantMsgId === lastAssistantMsgId
    ) {
      updated = updateMessageLookupsIncremental(
        cache.lookups,
        cache.normalizedCount,
        cache.messageCount,
        normalized,
        shown,
      )
    }

    const lookups = updated ?? buildMessageLookups(normalized, shown)
    if (updated) {
      tally.incremental++
    } else {
      tally.rebuild++
      tally.rebuildStepSum += index
    }

    cache = {
      key,
      lookups,
      normalizedCount: normalized.length,
      messageCount: shown.length,
      lastAssistantMsgId,
    }
  }
  return tally
}

function replayCurrent(steps: Step[]): Tally {
  const normalized: Message[] = []
  const shown: Message[] = []
  const tally = emptyTally()
  let cache: MessageLookupsCache | null = null

  for (const [index, step] of steps.entries()) {
    normalized.push(step.normalized)
    if (step.shown) shown.push(step.normalized)
    const resolved = resolveMessageLookups(cache, normalized, shown)
    cache = resolved.cache
    tally[resolved.source]++
    if (resolved.source === 'rebuild') tally.rebuildStepSum += index
  }
  return tally
}

/**
 * Just the cache key, no lookups at all. `computeMessageStructureKey` walks
 * both arrays and joins a string proportional to the conversation length, so
 * it is O(n) per render and O(n^2) over a session — the term that survives
 * once the rebuilds are gone.
 */
function replayKeyOnly(steps: Step[]): Tally {
  const normalized: Message[] = []
  const shown: Message[] = []
  for (const step of steps) {
    normalized.push(step.normalized)
    if (step.shown) shown.push(step.normalized)
    computeMessageStructureKey(normalized, shown)
  }
  return emptyTally()
}

/** Min of `repeats` runs — the least noisy estimate of the real cost. */
function timeReplay(
  replay: (steps: Step[]) => Tally,
  steps: Step[],
  repeats: number,
) {
  let best = Number.POSITIVE_INFINITY
  let tally = emptyTally()
  for (let run = 0; run < repeats; run++) {
    const started = performance.now()
    tally = replay(steps)
    best = Math.min(best, performance.now() - started)
  }
  return { ms: best, tally }
}

/**
 * heapUsed once collection has settled. One `Bun.gc(true)` is not enough after
 * a replay has produced a few hundred MB of garbage — JSC frees the rest on
 * later passes, which is how this probe first reported a *negative* size.
 */
function settledHeapUsed(): number {
  for (let i = 0; i < 4; i++) Bun.gc(true)
  return process.memoryUsage().heapUsed
}

/**
 * Retained size of one lookups object at this conversation length. Every
 * avoided rebuild is roughly this much garbage the GC does not have to move.
 */
function bytesPerRebuild(steps: Step[], samples = 40): number {
  const normalized = steps.map(step => step.normalized)
  const shown = steps.filter(step => step.shown).map(step => step.normalized)

  const keep: MessageLookups[] = []
  const before = settledHeapUsed()
  for (let i = 0; i < samples; i++) {
    keep.push(buildMessageLookups(normalized, shown))
  }
  const after = settledHeapUsed()
  // Keep `keep` reachable across the second collection, or we measure nothing.
  if (keep.length !== samples) throw new Error('unreachable')
  return (after - before) / samples
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function main(): void {
  const turns = Number(process.argv[2] ?? 800)
  const repeats = Number(process.argv[3] ?? 5)
  const steps = conversation(turns)

  console.log(
    `conversation: ${turns} turns, ${steps.length} messages ` +
      `(${steps.filter(s => s.shown).length} shown), min of ${repeats} runs\n`,
  )

  // Measured before the replays, on a clean heap.
  const perRebuild = bytesPerRebuild(steps)

  const results = [
    { name: 'rebuild', ...timeReplay(replayRebuildOnly, steps, repeats) },
    { name: 'legacy ', ...timeReplay(replayLegacy, steps, repeats) },
    { name: 'current', ...timeReplay(replayCurrent, steps, repeats) },
  ]

  const baseline = results[0]!.ms
  console.log('policy    total ms   vs rebuild   rebuilds  incremental  cached')
  for (const { name, ms, tally } of results) {
    console.log(
      `${name}  ${ms.toFixed(1).padStart(9)}   ${`${(baseline / ms).toFixed(1)}x`.padStart(10)}   ` +
        `${String(tally.rebuild).padStart(8)}  ${String(tally.incremental).padStart(11)}  ` +
        `${String(tally.cached).padStart(6)}`,
    )
  }

  const keyOnly = timeReplay(replayKeyOnly, steps, repeats)
  console.log(
    `\nof which just computeMessageStructureKey: ${keyOnly.ms.toFixed(1)} ms ` +
      `(${((keyOnly.ms / results[2]!.ms) * 100).toFixed(0)}% of current)`,
  )

  const legacy = results[1]!.tally
  const current = results[2]!.tally
  // A rebuild at step i costs about (i / N) of a full-size one.
  const garbage = (tally: Tally) =>
    (perRebuild * tally.rebuildStepSum) / steps.length
  console.log(
    `\nlookups object at full length: ${kb(perRebuild)}` +
      `\nrebuilds avoided vs legacy:    ${legacy.rebuild - current.rebuild}` +
      `\ntransient garbage, legacy:     ${mb(garbage(legacy))}` +
      `\ntransient garbage, current:    ${mb(garbage(current))}`,
  )
}

main()
