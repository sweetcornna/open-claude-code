/**
 * What `map(...).join('')` costs when hydration writes a whole session file.
 *
 * `hydrateRemoteSession` / `hydrateFromCCRv2InternalEvents` receive an array of
 * transcript entries and persist them as JSONL. Both did it the same way:
 *
 *   const content = remoteLogs.map(e => jsonStringify(e) + '\n').join('')
 *   await writeFile(sessionFile, content, { encoding: 'utf8', mode: 0o600 })
 *
 * That is three full copies of the document alive at once, on top of the entry
 * array the caller already holds:
 *
 *   1. `map` produces N serialized strings — the whole document, in pieces.
 *   2. `join('')` flattens them into one contiguous string — the whole
 *      document again, with the pieces still reachable via the map array.
 *   3. `writeFile` encodes that string into a UTF-8 Buffer — a third copy.
 *
 * JSONL is append-structured, so none of it is necessary: entries can be
 * serialized and handed to the fd in batches, capping the transient at one
 * batch no matter how large the session is.
 *
 * Strategies:
 *   materialize - map + join + writeFile (before).
 *   stream      - serialize into a bounded batch, flush to the fd (after).
 *
 * MEASUREMENT NOTE — this bench uses RSS, not `bun:jsc` heapStats.
 * `heapStats().heapSize` does not account for large string backing store at
 * all: measured, joining 2000 x 4 KB pieces into one 8 MB string moves
 * heapSize by 0.00 MB and heapCapacity by 0.05 MB, while RSS moves by the
 * full 7.9 MB. Since Bun's allocator does not return pages to the OS, RSS
 * after an operation is a sound proxy for RSS at its peak. Each strategy runs
 * in its own process for the same reason: whichever ran first donates its
 * pages to the second, which would then measure ~0.
 *
 * Run:
 *   bun run scripts/bench-session-jsonl-write.ts [entries] [kbPerEntry]
 */
import { open, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const rss = () => process.memoryUsage.rss()

/**
 * `bytes` of real, separately-allocated string storage.
 *
 * Single-character `repeat` on purpose: repeating a multi-character unit
 * yields a JSC rope that lazily references the unit and never allocates the
 * payload, so a bench built on one measures object headers, not content.
 */
function distinctText(bytes: number, fill: string): string {
  return fill.repeat(bytes)
}

/** A transcript entry in the shape hydration actually receives. */
function transcriptEntries(
  count: number,
  kbPerEntry: number,
  fill: string,
): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = []
  for (let i = 0; i < count; i++) {
    const id = (n: number) =>
      `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
    entries.push({
      parentUuid: i === 0 ? null : id(i - 1),
      uuid: id(i),
      isSidechain: false,
      type: i % 2 === 0 ? 'user' : 'assistant',
      message: {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [
          { type: 'text', text: distinctText(kbPerEntry * 1024, fill) },
        ],
      },
      sessionId: '00000000-0000-4000-8000-ffffffffffff',
      timestamp: new Date(1700000000000 + i * 1000).toISOString(),
      cwd: '/Users/dev/project',
      version: '2.0.0',
    })
  }
  return entries
}

/** Before: build the entire document, then hand it to writeFile. */
async function writeMaterialized(
  path: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const content = entries.map(e => JSON.stringify(e) + '\n').join('')
  await writeFile(path, content, { encoding: 'utf8', mode: 0o600 })
}

/** After: serialize into a bounded batch and flush it to the fd. */
const FLUSH_THRESHOLD = 65536

async function writeStreamed(
  path: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const fh = await open(path, 'w', 0o600)
  try {
    let batch: string[] = []
    let batchLength = 0
    for (const entry of entries) {
      const line = JSON.stringify(entry) + '\n'
      batch.push(line)
      batchLength += line.length
      if (batchLength >= FLUSH_THRESHOLD) {
        await fh.write(batch.join(''))
        batch = []
        batchLength = 0
      }
    }
    if (batchLength > 0) await fh.write(batch.join(''))
  } finally {
    await fh.close()
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`
}

/** One strategy, in its own process, so page reuse cannot mask the cost. */
async function runChild(
  strategy: 'materialize' | 'stream',
  count: number,
  kbPerEntry: number,
): Promise<void> {
  const path = join(tmpdir(), `bench-jsonl-${strategy}.jsonl`)
  const entries = transcriptEntries(count, kbPerEntry, 'a')

  // Baseline after the input exists: both strategies are charged only for
  // what the write itself adds on top of the array the caller already holds.
  const before = rss()
  const t0 = performance.now()
  if (strategy === 'materialize') {
    await writeMaterialized(path, entries)
  } else {
    await writeStreamed(path, entries)
  }
  const ms = performance.now() - t0
  const grew = rss() - before

  if (entries.length !== count) throw new Error('unreachable')
  const { size } = await stat(path)
  console.log(JSON.stringify({ strategy, grew, ms, size, path }))
}

async function main(): Promise<void> {
  const childStrategy = process.env.BENCH_STRATEGY
  const count = Number(process.argv[2] ?? 2000)
  const kbPerEntry = Number(process.argv[3] ?? 4)

  if (childStrategy === 'materialize' || childStrategy === 'stream') {
    await runChild(childStrategy, count, kbPerEntry)
    return
  }

  const payloadBytes = count * kbPerEntry * 1024
  console.log(
    `session: ${count} entries x ${kbPerEntry} KB = ${mb(payloadBytes)} of content\n`,
  )

  const results: Record<string, { grew: number; ms: number; path: string }> = {}
  for (const strategy of ['materialize', 'stream'] as const) {
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
    results[strategy] = JSON.parse(out.trim())
  }

  const a = results.materialize
  const b = results.stream
  if (!a || !b) throw new Error('unreachable')

  // The whole point is that the bytes on disk do not change.
  const [outA, outB] = await Promise.all([
    readFile(a.path, 'utf8'),
    readFile(b.path, 'utf8'),
  ])
  if (outA !== outB) throw new Error('output differs between strategies')

  console.log('strategy                     peak RSS growth        wall')
  console.log(
    `map+join+writeFile (before)  ${mb(a.grew).padStart(12)}   ${a.ms.toFixed(0).padStart(6)} ms`,
  )
  console.log(
    `batched fd writes  (after)   ${mb(b.grew).padStart(12)}   ${b.ms.toFixed(0).padStart(6)} ms`,
  )
  console.log(
    `\nsaved: ${mb(a.grew - b.grew)} (${(a.grew / Math.max(b.grew, 1)).toFixed(1)}x)` +
      `\nfile:  ${mb(outA.length)} on disk, byte-identical between strategies`,
  )

  await Promise.all([rm(a.path, { force: true }), rm(b.path, { force: true })])
}

await main()
