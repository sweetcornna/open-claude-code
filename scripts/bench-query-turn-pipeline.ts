/**
 * What it costs to rebuild the API-bound message view on every turn of the
 * query loop.
 *
 * `queryLoop` re-derives `messagesForQuery` from scratch at the top of every
 * iteration (query.ts). This measures the step that dominates: the
 * toolUseResult strip, a `.map()` over the whole post-boundary history that
 * shallow-copies every user message carrying a `toolUseResult` so the payload
 * can be dropped for the API without mutating the object the UI still
 * renders. The copies were thrown away and rebuilt identically on the next
 * turn, making it O(history) per turn and O(history^2) over a user turn that
 * drives many tool round-trips.
 *
 * Policies:
 *   none      - no strip at all; the floor, not a legal option.
 *   current   - the inline map as it stood before this change, verbatim.
 *   memoized  - `releaseToolUseResults`, what this branch ships.
 *
 * `memoized` calls the real shipped helper, so the numbers measure the change
 * in *when* work is redone, not a reimplementation of it.
 *
 * The other per-turn rebuild in the same block — the tool-result budget's
 * skip-set — is now cached on the tool array's identity in query.ts. It is
 * not modelled here because it does not scale with history: measured
 * separately at ~4 KB and 1.3 us per turn (7.8 MB / 2.6 ms over 2000 turns,
 * against 0.03 ms cached).
 *
 * Run:
 *   bun run scripts/bench-query-turn-pipeline.ts [turns] [repeats]
 */
import { heapStats } from 'bun:jsc'
import type { Message, UserMessage } from '../src/types/message.js'
import {
  assistantToolUse,
  fixtureUuid,
  userText,
  userToolResult,
} from '../tests/mocks/fixtures/conversation.js'
import {
  createToolResultReleaseCache,
  releaseToolUseResults,
} from '../src/utils/tools/toolResultRelease.js'

/**
 * A tool-result message as the query loop actually sees it: the API content
 * block plus the raw `toolUseResult` the UI renders from. `payloadChars`
 * stands in for a file read or command output still pinned to the message.
 */
function toolResultWithPayload(
  uuid: number,
  toolUseId: string,
  payloadChars: number,
): UserMessage {
  const msg = userToolResult(fixtureUuid(uuid), toolUseId, 'ok')
  return Object.assign(msg, {
    toolUseResult: {
      stdout: 'x'.repeat(payloadChars),
      stderr: '',
      interrupted: false,
    },
  }) as UserMessage
}

/**
 * The history at the end of `turns` turns: one user prompt, then a
 * tool_use / tool_result pair per turn. Matches the shape queryLoop
 * accumulates via `messagesForQuery.concat(assistantMessages, toolResults)`.
 */
function history(turns: number, payloadChars: number): Message[] {
  const messages: Message[] = [userText(fixtureUuid(1), 'go')]
  for (let turn = 0; turn < turns; turn++) {
    const base = 10 + turn * 2
    const toolUseId = `toolu_${turn}`
    messages.push(
      assistantToolUse({ messageId: `msg_${turn}`, uuid: fixtureUuid(base) }, [
        { id: toolUseId, name: 'Bash', input: { command: 'ls' } },
      ]),
      toolResultWithPayload(base + 1, toolUseId, payloadChars),
    )
  }
  return messages
}

/** query.ts:535 as it stands today. */
function stripCurrent(messages: Message[]): Message[] {
  return messages.map(msg => {
    if (
      msg.type !== 'user' ||
      !('toolUseResult' in msg) ||
      (msg as { toolUseResult?: unknown }).toolUseResult === undefined
    ) {
      return msg
    }
    const copy: typeof msg = { ...msg }
    delete (copy as Message & { toolUseResult?: unknown }).toolUseResult
    return copy
  })
}

type Policy = 'none' | 'current' | 'memoized'

/**
 * A cache that reports how many copies were actually constructed. Only `set`
 * is intercepted, so hits stay free and the timing stays honest.
 */
function countingCache() {
  const inner = createToolResultReleaseCache()
  let constructed = 0
  const cache = {
    get: (k: Message) => inner.get(k),
    set: (k: Message, v: Message) => {
      constructed++
      return inner.set(k, v)
    },
  } as unknown as ReturnType<typeof createToolResultReleaseCache>
  return { cache, constructed: () => constructed }
}

/**
 * Replay a session: at turn t the loop strips the first `2t+1` messages.
 * Returns the number of copies the policy actually constructed, which is the
 * term that grows quadratically.
 */
function replay(policy: Policy, messages: Message[], turns: number): number {
  const { cache, constructed } = countingCache()
  let built = 0
  for (let turn = 1; turn <= turns; turn++) {
    const view = messages.slice(0, turn * 2 + 1)
    if (policy === 'none') continue
    if (policy === 'current') {
      stripCurrent(view)
      // stripCurrent rebuilds every payload-carrying message, every turn.
      built += view.filter(
        m => (m as { toolUseResult?: unknown }).toolUseResult !== undefined,
      ).length
    } else {
      releaseToolUseResults(view, cache)
    }
  }
  return policy === 'memoized' ? constructed() : built
}

/**
 * JSC heap size once collection has settled. One `Bun.gc(true)` is not enough
 * after a replay has produced a few hundred MB of garbage — JSC frees the
 * rest on later passes.
 *
 * Deliberately `bun:jsc` rather than `process.memoryUsage().heapUsed`:
 * on Bun 1.3.13 heapUsed is a frozen constant (it reports the same value
 * before and after allocating 200k objects), so any probe built on it
 * silently measures zero.
 */
function settledHeapUsed(): number {
  for (let i = 0; i < 4; i++) Bun.gc(true)
  return heapStats().heapSize
}

/** Min of `repeats` runs — the least noisy estimate of the real cost. */
function timeReplay(
  policy: Policy,
  messages: Message[],
  turns: number,
  repeats: number,
) {
  let best = Number.POSITIVE_INFINITY
  let copies = 0
  for (let run = 0; run < repeats; run++) {
    const started = performance.now()
    copies = replay(policy, messages, turns)
    best = Math.min(best, performance.now() - started)
  }
  return { ms: best, copies }
}

/**
 * Retained size of one stripped copy, measured rather than guessed. Keeps
 * only the copies (not the arrays holding them) so the array spine does not
 * get charged to the per-copy figure.
 */
function bytesPerCopy(messages: Message[], samples = 400): number {
  const payloadCarrying = messages.filter(
    m => (m as { toolUseResult?: unknown }).toolUseResult !== undefined,
  )
  const keep: Message[] = []
  const before = settledHeapUsed()
  for (let i = 0; i < samples; i++) {
    for (const msg of payloadCarrying) {
      const copy: Message = { ...msg }
      delete (copy as Message & { toolUseResult?: unknown }).toolUseResult
      keep.push(copy)
    }
  }
  const after = settledHeapUsed()
  if (keep.length !== samples * payloadCarrying.length) {
    throw new Error('unreachable')
  }
  return (after - before) / keep.length
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function main(): void {
  const turns = Number(process.argv[2] ?? 400)
  const repeats = Number(process.argv[3] ?? 5)
  const payloadChars = 4096
  const messages = history(turns, payloadChars)

  console.log(
    `session: ${turns} turns, ${messages.length} messages, ` +
      `${payloadChars}-char tool payloads, min of ${repeats} runs\n`,
  )

  const perCopy = bytesPerCopy(messages)

  const results = [
    { name: 'none    ', ...timeReplay('none', messages, turns, repeats) },
    { name: 'current ', ...timeReplay('current', messages, turns, repeats) },
    { name: 'memoized', ...timeReplay('memoized', messages, turns, repeats) },
  ]

  const base = results[1]!.ms
  console.log('policy      total ms   vs current        copies built')
  for (const { name, ms, copies } of results) {
    console.log(
      `${name}  ${ms.toFixed(1).padStart(9)}   ${`${(base / ms).toFixed(1)}x`.padStart(10)}   ` +
        `${copies.toLocaleString().padStart(17)}`,
    )
  }

  const garbage = (copies: number) => perCopy * copies
  console.log(
    `\nbytes per stripped copy:     ${perCopy.toFixed(0)} B` +
      `\ntransient garbage, current:  ${mb(garbage(results[1]!.copies))}` +
      `\ntransient garbage, memoized: ${mb(garbage(results[2]!.copies))}`,
  )
}

main()
