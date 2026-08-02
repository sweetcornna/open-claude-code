// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per CLAUDE.md style; no collisions
// with the async-suffixed names.
// Sync fs primitives for readFileTailSync — separate from fs/promises
// imports above. Named (not wildcard) per CLAUDE.md style; no collisions
// with the async-suffixed names.
import { closeSync, fstatSync, openSync, readSync } from 'fs'
import { open as fsOpen } from 'fs/promises'
import { dirname } from 'path'
import { getFsImplementation } from '../fsOperations.js'
import { LITE_READ_BUF_SIZE } from '../sessionStoragePortable.js'
import { jsonStringify } from '../slowOperations.js'

/**
 * Append an entry to a session file. Creates the parent dir if missing.
 */
/* eslint-disable custom-rules/no-sync-fs -- sync callers (exit cleanup, materialize) */
export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = jsonStringify(entry) + '\n'
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  }
}

/**
 * Flush threshold for writeJsonlFile, in UTF-16 code units.
 *
 * Counted in code units rather than encoded bytes because measuring the latter
 * would mean encoding every line twice. Non-ASCII content therefore overshoots
 * slightly, which is fine: this bounds a transient, it is not a hard cap.
 */
const JSONL_WRITE_BATCH_CHARS = LITE_READ_BUF_SIZE

/**
 * Write a whole JSONL file from an iterable of entries, truncating whatever
 * was there before.
 *
 * The obvious spelling — `entries.map(e => jsonStringify(e) + '\n').join('')`
 * handed to `writeFile` — keeps three full copies of the document alive at
 * once: the mapped pieces, the joined string, and the UTF-8 encode of it. For
 * the hydration paths, which replace an entire session transcript in one go,
 * that is the dominant allocation. JSONL is append-structured, so serializing
 * into a bounded batch and flushing it to the fd caps the transient at one
 * batch regardless of session size (measured on a 62.5 MB session: 263.6 MB
 * peak RSS growth before, 81.9 MB after — see
 * scripts/bench-session-jsonl-write.ts).
 *
 * Opened with 'w', so an empty iterable produces an empty file — callers rely
 * on that to clear a transcript. `mode` applies only on creation, matching the
 * `writeFile(..., { mode: 0o600 })` this replaced.
 */
export async function writeJsonlFile(
  fullPath: string,
  entries: Iterable<unknown>,
): Promise<void> {
  const fh = await fsOpen(fullPath, 'w', 0o600)
  try {
    let batch: string[] = []
    let batchChars = 0
    for (const entry of entries) {
      const line = jsonStringify(entry) + '\n'
      batch.push(line)
      batchChars += line.length
      if (batchChars >= JSONL_WRITE_BATCH_CHARS) {
        await fh.write(batch.join(''))
        batch = []
        batchChars = 0
      }
    }
    if (batchChars > 0) await fh.write(batch.join(''))
  } finally {
    await fh.close()
  }
}

/**
 * Sync tail read for reAppendSessionMetadata's external-writer check.
 * fstat on the already-open fd (no extra path lookup); reads the same
 * LITE_READ_BUF_SIZE window that readLiteMetadata scans. Returns empty
 * string on any error so callers fall through to unconditional behavior.
 */
export function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // closeSync can throw; swallow to preserve return '' contract
      }
    }
  }
}
