import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Behavioral pins for the streaming session-file IO in sessionStorage/fileIO.ts.
//
// writeJsonlFile replaced `entries.map(e => jsonStringify(e) + '\n').join('')`
// fed to writeFile. The whole point of the change is that nothing observable
// moves: the bytes on disk, the truncate-on-write semantics that hydration
// relies on to clear a transcript, and the 0o600 creation mode all have to
// match the spelling it replaced. So the oracle here is literally the old
// expression, computed in the test.
//
// No mock.module: fileIO.ts loads cleanly on its own, and Bun's mock.module is
// process-global (last-write-wins across the whole test process), so mocking
// here would leak into every other test file. Isolation is a temp dir.

const { writeJsonlFile } = await import('../sessionStorage/fileIO.js')

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'occ-streaming-io-'))
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

/** Exactly the expression writeJsonlFile replaced. */
function materialize(entries: unknown[]): string {
  return entries.map(e => JSON.stringify(e) + '\n').join('')
}

describe('writeJsonlFile', () => {
  test('produces the same bytes as map+join for a mixed corpus', async () => {
    // Deliberately spans the 64 KB flush threshold in both directions: many
    // entries far below it, and single entries far above it, so a batch
    // boundary lands mid-corpus and a single line exceeds a whole batch.
    const entries: unknown[] = []
    for (let i = 0; i < 400; i++) {
      entries.push({ type: 'user', uuid: `u-${i}`, text: 'x'.repeat(300) })
    }
    entries.push({ type: 'assistant', uuid: 'big', text: 'y'.repeat(200_000) })
    for (let i = 0; i < 400; i++) {
      entries.push({ type: 'assistant', uuid: `a-${i}`, text: 'z'.repeat(300) })
    }

    const path = join(tempDir, 'mixed.jsonl')
    await writeJsonlFile(path, entries)

    expect(await readFile(path, 'utf8')).toBe(materialize(entries))
  })

  test('encodes non-ASCII identically despite the char-counted threshold', async () => {
    // The flush threshold counts UTF-16 code units, not encoded bytes, so
    // multi-byte content overshoots a batch. That must not change the output.
    const entries: unknown[] = []
    for (let i = 0; i < 600; i++) {
      entries.push({ uuid: `u-${i}`, text: '你好世界'.repeat(50), emoji: '🙂' })
    }

    const path = join(tempDir, 'unicode.jsonl')
    await writeJsonlFile(path, entries)

    const written = await readFile(path, 'utf8')
    expect(written).toBe(materialize(entries))
    // Guard against a lost surrogate pair at a batch seam.
    expect(written).toContain('🙂')
    expect(written.includes('�')).toBe(false)
  })

  test('writes an empty file for an empty iterable', async () => {
    // hydrateRemoteSession relies on this to clear a local transcript when
    // the remote has no entries.
    const path = join(tempDir, 'empty.jsonl')
    await writeJsonlFile(path, [])

    expect(await readFile(path, 'utf8')).toBe('')
  })

  test('truncates an existing longer file', async () => {
    const path = join(tempDir, 'truncate.jsonl')
    await writeFile(path, 'stale\n'.repeat(10_000))

    await writeJsonlFile(path, [{ uuid: 'fresh' }])

    expect(await readFile(path, 'utf8')).toBe('{"uuid":"fresh"}\n')
  })

  test('creates the file 0o600', async () => {
    const path = join(tempDir, 'mode.jsonl')
    await writeJsonlFile(path, [{ uuid: 'a' }])

    const { mode } = await stat(path)
    expect(mode & 0o777).toBe(0o600)
  })

  test('accepts any iterable, not just arrays', async () => {
    // hydrateFromCCRv2InternalEvents passes a mapped view; keeping the
    // parameter an Iterable lets callers avoid materializing an array.
    function* gen(): Generator<unknown> {
      yield { uuid: 'a' }
      yield { uuid: 'b' }
    }

    const path = join(tempDir, 'iterable.jsonl')
    await writeJsonlFile(path, gen())

    expect(await readFile(path, 'utf8')).toBe('{"uuid":"a"}\n{"uuid":"b"}\n')
  })
})
