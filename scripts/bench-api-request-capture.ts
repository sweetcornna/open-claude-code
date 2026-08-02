/**
 * What `captureAPIRequest` retained by holding on to the last request's
 * `messages` array.
 *
 * `captureAPIRequest` (src/utils/log.ts) already strips `messages` out of the
 * params it keeps for bug reports, precisely so the conversation is not
 * retained. It then put the messages back into a second slot:
 *
 *   setLastAPIRequestMessages(process.env.USER_TYPE === 'ant' ? messages : null)
 *
 * The value is the wire-format `MessageParam[]` — post-compaction,
 * post-CLAUDE.md-injection, including `tool_result` payloads and image blocks
 * with inline base64. `addCacheBreakpoints` hands back a fresh array of fresh
 * block wrappers, but their contents are aliased from the live conversation,
 * so the slot pins the whole content graph.
 *
 * That matters most right after a compaction: the live conversation drops the
 * pre-compaction messages, and `/compact` (unlike `/clear`) never cleared this
 * slot, so the slot was left as the sole owner of everything compaction was
 * supposed to release — until the next main-thread request overwrote it.
 *
 * Policies:
 *   retain - keep the messages array, as the ant path did (before).
 *   drop   - keep nothing, which is what shipping now does for everyone (after).
 *
 * The slot had no production reader, so `drop` loses no diagnostic: the
 * request params still reach bug reports via `lastAPIRequest`
 * (Feedback.tsx:228), and the conversation itself is on disk in the transcript.
 *
 * Run:
 *   bun run scripts/bench-api-request-capture.ts [messages] [kbPerMessage] [images]
 */
import { heapStats } from 'bun:jsc'

/**
 * JSC heap size once collection has settled.
 *
 * Deliberately `bun:jsc` rather than `process.memoryUsage().heapUsed`: on Bun
 * 1.3.13 heapUsed is a frozen constant (measured: ~212 KB before and after
 * allocating 50k strings), so any probe built on it reads zero.
 */
function settledHeapUsed(): number {
  for (let i = 0; i < 6; i++) Bun.gc(true)
  return heapStats().heapSize
}

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

type WireMessage = { role: 'user' | 'assistant'; content: Block[] }

/**
 * `bytes` of real, separately-allocated string storage.
 *
 * Single-character `repeat` on purpose. Repeating a multi-character unit
 * yields a JSC rope that lazily references the one unit, so it never
 * allocates the payload: measured, 400 x 4 KB built that way costs 0.17 MB
 * instead of 1.58 MB. Repeating one character allocates flat backing store,
 * and JSC does not intern equal strings built separately, so every call here
 * is its own buffer even though the contents match.
 */
function distinctText(bytes: number, fill: string): string {
  return fill.repeat(bytes)
}

/**
 * A conversation in the shape the API client actually sends: alternating
 * turns, tool results carrying command/file output, and a few screenshots
 * still inline as base64.
 */
function wireConversation(
  count: number,
  kbPerMessage: number,
  images: number,
  fill: string,
): WireMessage[] {
  const messages: WireMessage[] = []
  for (let i = 0; i < count; i++) {
    const body = distinctText(kbPerMessage * 1024, fill)
    const blocks: Block[] =
      i % 2 === 0
        ? [{ type: 'text', text: body }]
        : [{ type: 'tool_result', tool_use_id: `toolu_${i}`, content: body }]
    messages.push({ role: i % 2 === 0 ? 'user' : 'assistant', content: blocks })
  }
  for (let i = 0; i < images; i++) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: distinctText(200 * 1024, fill),
          },
        },
      ],
    })
  }
  return messages
}

type Policy = 'retain' | 'drop'

/** The module-level diagnostic slot, modelled. */
type Slot = { lastAPIRequestMessages: WireMessage[] | null }

/**
 * Bytes of the PRE-compaction conversation that survive the compaction
 * because the capture slot still points at them.
 *
 * Measured on the allocation side. `heapStats().heapSize` grows promptly but
 * does not shrink promptly — JSC keeps the pages — so a post-release sample
 * reads noise. Growth is reliable: after compaction the session keeps working
 * and allocates a fresh generation of messages. If generation A was released,
 * generation B reuses its space and the delta is ~0; if the slot still pins
 * generation A, the delta is A's full size.
 */
function pinnedAcrossCompaction(
  policy: Policy,
  count: number,
  kbPerMessage: number,
  images: number,
): number {
  const slot: Slot = { lastAPIRequestMessages: null }

  // A turn goes out on the main thread; captureAPIRequest runs.
  let live: WireMessage[] | null = wireConversation(
    count,
    kbPerMessage,
    images,
    'a',
  )
  if (policy === 'retain') slot.lastAPIRequestMessages = live

  // Sampled while the conversation is still live, so the release and the
  // replacement both land between the two samples. Sampling after the release
  // instead would charge both policies for generation B alone and read
  // identical either way.
  const before = settledHeapUsed()

  // Compaction: the live conversation is replaced by a summary, so the app
  // drops its own reference to everything before the boundary.
  live = null
  // The session continues and builds a fresh generation of messages.
  const next = wireConversation(count, kbPerMessage, images, 'b')
  const after = settledHeapUsed()

  // Keep both reachable across the samples.
  if (next.length !== count + images) throw new Error('unreachable')
  if (policy === 'retain' && slot.lastAPIRequestMessages === null) {
    throw new Error('unreachable')
  }
  return after - before
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function main(): void {
  const count = Number(process.argv[2] ?? 300)
  const kbPerMessage = Number(process.argv[3] ?? 2)
  const images = Number(process.argv[4] ?? 4)
  const contentBytes = count * kbPerMessage * 1024 + images * 200 * 1024

  console.log(
    `conversation: ${count} messages x ${kbPerMessage} KB + ${images} inline images ` +
      `= ${mb(contentBytes)}\n`,
  )

  const results = (['retain', 'drop'] as const).map(policy => ({
    policy,
    pinned: pinnedAcrossCompaction(policy, count, kbPerMessage, images),
  }))

  console.log('policy                  pre-compaction payload still pinned')
  for (const { policy, pinned } of results) {
    const label =
      policy === 'retain'
        ? 'retain messages (before)'
        : 'drop messages  (after) '
    console.log(`${label}   ${mb(pinned).padStart(12)}`)
  }

  const [before, after] = results
  if (!before || !after) throw new Error('unreachable')
  console.log(
    `\nfreed by dropping the capture: ${mb(before.pinned - after.pinned)}` +
      `\nconversation size:             ${mb(contentBytes)}`,
  )
}

main()
