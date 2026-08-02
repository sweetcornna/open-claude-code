/**
 * What the tombstone fallback cost when the orphaned entry was not in the
 * last 64 KB of the session file.
 *
 * `removeMessageByUuid` (src/utils/sessionStorage/transcriptWriter.ts) deletes
 * one line from the transcript when a streaming attempt leaves an orphaned
 * message behind. It read the tail first, and if the entry was not in there it
 * fell back to:
 *
 *   const content = await readFile(file, { encoding: 'utf-8' })
 *   const lines = content.split('\n').filter(...jsonParse each line...)
 *   await writeFile(file, lines.join('\n'))
 *
 * Four copies of the document: the decoded string, the split substrings, the
 * parsed entries, and the joined result. That is why the fallback had to
 * refuse files over 50 MB outright — and silently drop those tombstones,
 * leaving the orphan in the transcript forever.
 *
 * Deleting one line does not require any of it. The line can be located by
 * walking backward from EOF a window at a time, then spliced out by copying
 * the trailing bytes down over it and truncating — both bounded by one buffer.
 *
 * Strategies:
 *   rewrite - read whole / split / filter / join / write (before).
 *   splice  - windowed backward scan + chunked shift + truncate (after).
 *
 * MEASUREMENT NOTE — RSS, not `bun:jsc` heapStats. heapSize does not account
 * for large string backing store at all (measured: joining 2000 x 4 KB pieces
 * into one 8 MB string moves heapSize 0.00 MB, RSS 7.9 MB). Bun's allocator
 * does not return pages, so post-operation RSS is a sound peak proxy, and for
 * the same reason each strategy runs in its own process — whichever ran first
 * would donate its pages to the second.
 *
 * Run:
 *   bun run scripts/bench-tombstone-removal.ts [fileMB] [targetOffsetKB]
 */
import { open, readFile, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

const rss = () => process.memoryUsage.rss()
const WINDOW = 65536
const TARGET_UUID = '00000000-0000-4000-8000-0000000000ff'

function mb(bytes: number): string {
  return `${(bytes / 1048576).toFixed(2)} MB`
}

/**
 * A session file of roughly `fileMB`, with the tombstone target placed
 * `targetOffsetKB` from the end — far enough back that the tail read misses
 * it, which is the only case that reached the fallback.
 *
 * Single-character `repeat` for the payload: repeating a multi-character unit
 * yields a JSC rope that never allocates the content, so the file would not
 * have the intended size on disk.
 */
async function buildSession(
  path: string,
  fileMB: number,
  targetOffsetKB: number,
): Promise<void> {
  const entry = (uuid: string, n: number, text: string) =>
    JSON.stringify({
      parentUuid: null,
      uuid,
      type: n % 2 === 0 ? 'user' : 'assistant',
      message: { role: 'user', content: [{ type: 'text', text }] },
      sessionId: '00000000-0000-4000-8000-ffffffffffff',
      timestamp: new Date(1700000000000 + n * 1000).toISOString(),
    }) + '\n'

  const body = 'a'.repeat(4096)
  const fh = await open(path, 'w', 0o600)
  try {
    const totalBytes = fileMB * 1048576
    const tailBytes = targetOffsetKB * 1024
    let written = 0
    let n = 0
    let placedTarget = false
    let batch: string[] = []
    let batchLen = 0

    while (written < totalBytes) {
      // Place the target once only `tailBytes` remain to be written.
      const isTarget = !placedTarget && written >= totalBytes - tailBytes
      if (isTarget) placedTarget = true
      const uuid = isTarget
        ? TARGET_UUID
        : `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
      const line = entry(uuid, n, body)
      batch.push(line)
      batchLen += line.length
      written += line.length
      n++
      if (batchLen >= WINDOW) {
        await fh.write(batch.join(''))
        batch = []
        batchLen = 0
      }
    }
    if (batchLen > 0) await fh.write(batch.join(''))
  } finally {
    await fh.close()
  }
}

/** Before: decode the whole file, split, filter, join, write it all back. */
async function removeByRewrite(path: string, uuid: string): Promise<void> {
  const content = await readFile(path, { encoding: 'utf-8' })
  const lines = content.split('\n').filter((line: string) => {
    if (!line.trim()) return true
    try {
      return (JSON.parse(line) as { uuid?: string }).uuid !== uuid
    } catch {
      return true
    }
  })
  await writeFile(path, lines.join('\n'), { encoding: 'utf8' })
}

/** After: locate by windowed backward scan, then shift the tail down. */
async function removeBySplice(path: string, uuid: string): Promise<void> {
  const fh = await open(path, 'r+')
  try {
    const { size } = await fh.stat()
    if (size === 0) return
    const needle = Buffer.from(`"uuid":"${uuid}"`)
    const scratch = Buffer.allocUnsafe(WINDOW)

    let windowEnd = size
    let at = -1
    while (windowEnd > 0) {
      const windowStart = Math.max(0, windowEnd - WINDOW)
      const { bytesRead } = await fh.read(
        scratch,
        0,
        windowEnd - windowStart,
        windowStart,
      )
      if (bytesRead === 0) break
      const idx = scratch.subarray(0, bytesRead).lastIndexOf(needle)
      if (idx >= 0) {
        at = windowStart + idx
        break
      }
      if (windowStart === 0) break
      windowEnd = windowStart + needle.length - 1
    }
    if (at < 0) return

    let start = 0
    let pos = at
    while (pos > 0) {
      const chunkStart = Math.max(0, pos - scratch.length)
      const { bytesRead } = await fh.read(
        scratch,
        0,
        pos - chunkStart,
        chunkStart,
      )
      if (bytesRead === 0) break
      const nl = scratch.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (nl >= 0) {
        start = chunkStart + nl + 1
        break
      }
      pos = chunkStart
    }
    let end = size
    pos = at
    while (pos < size) {
      const { bytesRead } = await fh.read(
        scratch,
        0,
        Math.min(scratch.length, size - pos),
        pos,
      )
      if (bytesRead === 0) break
      const nl = scratch.subarray(0, bytesRead).indexOf(0x0a)
      if (nl >= 0) {
        end = pos + nl + 1
        break
      }
      pos += bytesRead
    }

    let src = end
    let dst = start
    while (src < size) {
      const { bytesRead } = await fh.read(
        scratch,
        0,
        Math.min(scratch.length, size - src),
        src,
      )
      if (bytesRead === 0) break
      await fh.write(scratch, 0, bytesRead, dst)
      src += bytesRead
      dst += bytesRead
    }
    await fh.truncate(dst)
  } finally {
    await fh.close()
  }
}

async function runChild(
  strategy: 'rewrite' | 'splice',
  golden: string,
  path: string,
): Promise<void> {
  // Copy outside the measured window so file generation is not charged.
  await Bun.write(path, Bun.file(golden))

  const before = rss()
  const t0 = performance.now()
  if (strategy === 'rewrite') {
    await removeByRewrite(path, TARGET_UUID)
  } else {
    await removeBySplice(path, TARGET_UUID)
  }
  const ms = performance.now() - t0
  const grew = rss() - before

  const { size } = await stat(path)
  console.log(JSON.stringify({ strategy, grew, ms, size, path }))
}

async function main(): Promise<void> {
  const fileMB = Number(process.argv[2] ?? 50)
  const targetOffsetKB = Number(process.argv[3] ?? 512)
  const golden = join(tmpdir(), 'bench-tombstone-golden.jsonl')

  const childStrategy = process.env.BENCH_STRATEGY
  if (childStrategy === 'rewrite' || childStrategy === 'splice') {
    await runChild(
      childStrategy,
      golden,
      join(tmpdir(), `bench-tombstone-${childStrategy}.jsonl`),
    )
    return
  }

  await buildSession(golden, fileMB, targetOffsetKB)
  const { size: goldenSize } = await stat(golden)
  console.log(
    `session: ${mb(goldenSize)}, tombstone target ~${targetOffsetKB} KB from EOF ` +
      `(past the 64 KB tail read, so this is the fallback case)\n`,
  )

  const results: Record<string, { grew: number; ms: number; path: string }> = {}
  for (const strategy of ['rewrite', 'splice'] as const) {
    const proc = Bun.spawn(
      [
        process.execPath,
        'run',
        import.meta.path,
        String(fileMB),
        String(targetOffsetKB),
      ],
      { env: { ...process.env, BENCH_STRATEGY: strategy }, stdout: 'pipe' },
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    results[strategy] = JSON.parse(out.trim())
  }

  const a = results.rewrite
  const b = results.splice
  if (!a || !b) throw new Error('unreachable')

  // The whole point is that the surviving bytes are the same either way.
  const [outA, outB] = await Promise.all([readFile(a.path), readFile(b.path)])
  if (!outA.equals(outB)) throw new Error('output differs between strategies')
  if (outA.includes(Buffer.from(TARGET_UUID))) {
    throw new Error('target entry was not removed')
  }

  console.log('strategy                        peak RSS growth        wall')
  console.log(
    `read/split/filter/join (before) ${mb(a.grew).padStart(12)}   ${a.ms.toFixed(0).padStart(6)} ms`,
  )
  console.log(
    `windowed scan + splice (after)  ${mb(b.grew).padStart(12)}   ${b.ms.toFixed(0).padStart(6)} ms`,
  )
  console.log(
    `\nsaved: ${mb(a.grew - b.grew)} (${(a.grew / Math.max(b.grew, 1)).toFixed(0)}x)` +
      `\nfile:  ${mb(outA.length)} after removal, byte-identical between strategies`,
  )

  await Promise.all([
    rm(a.path, { force: true }),
    rm(b.path, { force: true }),
    rm(golden, { force: true }),
  ])
}

await main()
