/**
 * What the transcript write queue accumulates before it touches the disk.
 *
 * `Project.drainWriteQueue` (src/utils/sessionStorage/transcriptWriter.ts)
 * batches queued entries into one string and appends it:
 *
 *   let content = ''
 *   for (const { entry, resolve } of batch) {
 *     const line = jsonStringify(entry) + '\n'
 *     if (content.length + line.length >= this.MAX_CHUNK_BYTES) { ...flush... }
 *     content += line
 *   }
 *
 * `MAX_CHUNK_BYTES` was 100 MB, so up to 100 MB of transcript could be built
 * in memory before a single appendFile. The queue is capped at 1000 entries,
 * which sounds small until a turn produces large tool results: 1000 entries
 * x 96 KB lands right at the cap.
 *
 * `content += line` is cheap on its own — JSC builds a rope, not a copy — but
 * the rope must be flattened into one contiguous string to hand to appendFile
 * and then encoded to UTF-8, so the moment of the write holds the line
 * strings, the flattened document, and its encoding at once.
 *
 * THE FINDING: the cap is the entire story, and the rope is not the problem.
 * Replacing `content +=` with array + join — the shape used to fix the
 * hydration path — measures WORSE at the same threshold, because join
 * allocates the flat result while the array still holds every piece:
 *
 *   500 x 64 KB, both flushing at 4 MB:  rope 47.1 MB, array+join 66.8 MB
 *   1000 x 96 KB, both flushing at 4 MB: rope 75.4 MB, array+join 118.3 MB
 *
 * So the fix is to lower the cap and leave the accumulator alone. The
 * array+join variant is kept here as the rejected alternative, so nobody
 * re-proposes it from the shape of the hydration fix.
 *
 * Strategies:
 *   rope-100mb     - rope, flush at 100 MB (before).
 *   rope-4mb       - rope, flush at 4 MB (after).
 *   array-join-4mb - array + join, flush at 4 MB (rejected).
 *
 * MEASUREMENT NOTE — RSS, not `bun:jsc` heapStats. heapSize does not account
 * for large string backing store at all (measured: joining 2000 x 4 KB pieces
 * into one 8 MB string moves heapSize 0.00 MB, RSS 7.9 MB). Bun's allocator
 * does not return pages, so post-operation RSS is a sound peak proxy, and for
 * the same reason each strategy runs in its own process — whichever ran first
 * would donate its pages to the second.
 *
 * Run:
 *   bun run scripts/bench-transcript-drain.ts [entries] [kbPerEntry]
 */
import { appendFile, readFile, rm, stat } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const rss = () => process.memoryUsage.rss()
const MB = 1048576

const STRATEGIES = ['rope-100mb', 'rope-4mb', 'array-join-4mb'] as const
type Strategy = (typeof STRATEGIES)[number]

const LABEL: Record<Strategy, string> = {
  'rope-100mb': 'rope, 100 MB cap   (before)  ',
  'rope-4mb': 'rope, 4 MB cap     (after)   ',
  'array-join-4mb': 'array+join, 4 MB   (rejected)',
}

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(2)} MB`
}

/**
 * Queued entries in the shape the drain actually serializes.
 *
 * Single-character `repeat` for the payload: repeating a multi-character unit
 * yields a JSC rope that lazily references the unit and never allocates the
 * content, so a bench built on one measures object headers, not bytes.
 */
function queuedEntries(
  count: number,
  kbPerEntry: number,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    entries.push({
      parentUuid: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      uuid: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: `toolu_${i}`,
            content: 'a'.repeat(kbPerEntry * 1024),
          },
        ],
      },
      sessionId: '00000000-0000-4000-8000-ffffffffffff',
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
    })
  }
  return entries
}

/** Rope accumulation, flushed at `capChars`. This is the production shape. */
async function drainRope(
  path: string,
  entries: Record<string, unknown>[],
  capChars: number,
): Promise<void> {
  let content = ''
  for (const entry of entries) {
    const line = JSON.stringify(entry) + '\n'
    if (content.length + line.length >= capChars) {
      await appendFile(path, content, { mode: 0o600 })
      content = ''
    }
    content += line
  }
  if (content.length > 0) await appendFile(path, content, { mode: 0o600 })
}

/** The rejected alternative: array + join at the same threshold. */
async function drainArrayJoin(
  path: string,
  entries: Record<string, unknown>[],
  capChars: number,
): Promise<void> {
  let chunk: string[] = []
  let chunkChars = 0
  for (const entry of entries) {
    const line = JSON.stringify(entry) + '\n'
    if (chunkChars > 0 && chunkChars + line.length >= capChars) {
      await appendFile(path, chunk.join(''), { mode: 0o600 })
      chunk = []
      chunkChars = 0
    }
    chunk.push(line)
    chunkChars += line.length
  }
  if (chunkChars > 0) await appendFile(path, chunk.join(''), { mode: 0o600 })
}

async function runChild(
  strategy: Strategy,
  count: number,
  kbPerEntry: number,
): Promise<void> {
  const path = join(tmpdir(), `bench-drain-${strategy}.jsonl`)
  await rm(path, { force: true })
  const entries = queuedEntries(count, kbPerEntry)

  const before = rss()
  const t0 = performance.now()
  if (strategy === 'rope-100mb') {
    await drainRope(path, entries, 100 * MB)
  } else if (strategy === 'rope-4mb') {
    await drainRope(path, entries, 4 * MB)
  } else {
    await drainArrayJoin(path, entries, 4 * MB)
  }
  const ms = performance.now() - t0
  const grew = rss() - before

  if (entries.length !== count) throw new Error('unreachable')
  const { size } = await stat(path)
  console.log(JSON.stringify({ strategy, grew, ms, size, path }))
}

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 1000)
  const kbPerEntry = Number(process.argv[3] ?? 96)

  const childStrategy = process.env.BENCH_STRATEGY as Strategy | undefined
  if (childStrategy && STRATEGIES.includes(childStrategy)) {
    await runChild(childStrategy, count, kbPerEntry)
    return
  }

  console.log(
    `drain: ${count} queued entries x ${kbPerEntry} KB = ` +
      `${mb(count * kbPerEntry * 1024)} in one flush\n`,
  )

  const results = new Map<
    Strategy,
    { grew: number; ms: number; path: string }
  >()
  for (const strategy of STRATEGIES) {
    const proc = Bun.spawn(
      [
        process.execPath,
        'run',
        import.meta.path,
        String(count),
        String(kbPerEntry),
      ],
      { env: { ...process.env, BENCH_STRATEGY: strategy }, stdout: 'pipe' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    results.set(strategy, JSON.parse(out.trim()))
  }

  // The whole point is that the bytes on disk do not change.
  const outputs = await Promise.all(
    STRATEGIES.map(s => readFile(results.get(s)!.path)),
  )
  const [reference] = outputs
  if (!reference) throw new Error('unreachable')
  for (const out of outputs) {
    if (!out.equals(reference)) {
      throw new Error('output differs between strategies')
    }
  }

  console.log('strategy                        peak RSS growth        wall')
  for (const strategy of STRATEGIES) {
    const r = results.get(strategy)!
    console.log(
      `${LABEL[strategy]}   ${mb(r.grew).padStart(12)}   ${r.ms.toFixed(0).padStart(6)} ms`,
    )
  }

  const before = results.get('rope-100mb')!
  const after = results.get('rope-4mb')!
  console.log(
    `\nsaved by the lower cap: ${mb(before.grew - after.grew)} ` +
      `(${(before.grew / Math.max(after.grew, 1)).toFixed(1)}x)` +
      `\nfile: ${mb(reference.length)} appended, identical across all three`,
  )

  await Promise.all(
    STRATEGIES.map(s => rm(results.get(s)!.path, { force: true })),
  )
}

await main()
