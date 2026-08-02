import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import type { UUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
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

const {
  flushSessionStorage,
  loadTranscriptFile,
  recordTranscript,
  removeTranscriptMessage,
  resetProjectForTesting,
  setSessionFileForTesting,
} = await import('../sessionStorage.js')

/** The window removeMessageByUuid walks backward in, from sessionStoragePortable. */
const WINDOW = 65536

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

// removeMessageByUuid walks backward from EOF in windows and splices the
// matched line out with a positional rewrite + truncate. It previously fell
// back to read-whole-file/split/filter/join for anything not in the last 64 KB
// and refused files over 50 MB. That fallback is gone; these pin the behavior
// that has to survive, none of which was covered before.

const uuidOf = (n: number): UUID =>
  `${String(n).repeat(8)}-1111-4111-8111-111111111111` as UUID

/** A transcript line whose `"uuid":"..."` key sits at byte offset 1. */
function line(uuid: UUID, text: string): string {
  return `{"uuid":"${uuid}","text":${JSON.stringify(text)}}\n`
}

describe('removeTranscriptMessage', () => {
  let sessionFile: string
  let originalConfigDir: string | undefined

  beforeEach(() => {
    mkdirSync(join(tempDir, 'projects'), { recursive: true })
    sessionFile = join(tempDir, 'projects', 'tombstone.jsonl')

    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir

    // setSessionFileForTesting lazily constructs the singleton, so the reset
    // has to come first or it would keep a stale path from another test file.
    resetProjectForTesting()
    setSessionFileForTesting(sessionFile)
  })

  afterEach(async () => {
    await flushSessionStorage()
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  afterAll(() => {
    // Leave no Project singleton pointing at a deleted temp path for
    // whichever test file bun runs next in this process.
    resetProjectForTesting()
  })

  test('removes the last entry', async () => {
    const keep = line(uuidOf(1), 'first') + line(uuidOf(2), 'second')
    await writeFile(sessionFile, keep + line(uuidOf(3), 'orphan'))

    await removeTranscriptMessage(uuidOf(3))

    expect(await readFile(sessionFile, 'utf8')).toBe(keep)
  })

  test('removes a middle entry and keeps everything around it', async () => {
    await writeFile(
      sessionFile,
      line(uuidOf(1), 'first') +
        line(uuidOf(2), 'orphan') +
        line(uuidOf(3), 'third'),
    )

    await removeTranscriptMessage(uuidOf(2))

    expect(await readFile(sessionFile, 'utf8')).toBe(
      line(uuidOf(1), 'first') + line(uuidOf(3), 'third'),
    )
  })

  test('removes the first entry', async () => {
    await writeFile(
      sessionFile,
      line(uuidOf(1), 'orphan') + line(uuidOf(2), 'second'),
    )

    await removeTranscriptMessage(uuidOf(1))

    expect(await readFile(sessionFile, 'utf8')).toBe(line(uuidOf(2), 'second'))
  })

  test('removes an entry sitting many windows back from EOF', async () => {
    // The old code read only the last 64 KB and fell through to the
    // whole-file rewrite for this; now it is the same backward walk.
    const target = line(uuidOf(2), 'orphan')
    const head = line(uuidOf(1), 'first')
    const tail = line(uuidOf(3), 'x'.repeat(300_000))
    await writeFile(sessionFile, head + target + tail)

    await removeTranscriptMessage(uuidOf(2))

    expect(await readFile(sessionFile, 'utf8')).toBe(head + tail)
  })

  test('removes an entry whose own line is larger than a window', async () => {
    // Exercises the outward line-boundary scan: the terminating newline is
    // ~200 KB past the matched `"uuid":"..."`.
    const head = line(uuidOf(1), 'first')
    const tail = line(uuidOf(3), 'third')
    await writeFile(
      sessionFile,
      head + line(uuidOf(2), 'y'.repeat(200_000)) + tail,
    )

    await removeTranscriptMessage(uuidOf(2))

    expect(await readFile(sessionFile, 'utf8')).toBe(head + tail)
  })

  test('finds a match straddling a window seam', async () => {
    // Windows step back with an overlap of needle.length - 1. Without it, a
    // `"uuid":"..."` starting one byte before a seam is invisible to both the
    // window that ends at the seam and the one that starts there. Lay the
    // file out so the needle begins at exactly size - WINDOW - 1.
    const target = uuidOf(2)
    const head = line(uuidOf(1), 'first')
    const targetLine = line(target, 'orphan')
    // needle starts at head.length + 1; we need that to equal size - WINDOW - 1
    // where size = head.length + targetLine.length + tailLength.
    const tailLength = WINDOW + 2 - targetLine.length
    const prefix = `{"uuid":"${uuidOf(3)}","text":"`
    const suffix = `"}\n`
    const tail =
      prefix + 'z'.repeat(tailLength - prefix.length - suffix.length) + suffix
    expect(tail.length).toBe(tailLength)

    const content = head + targetLine + tail
    await writeFile(sessionFile, content)
    // Confirm the layout actually puts the needle across the seam, so this
    // test fails loudly if the window size ever changes.
    expect(content.indexOf(`"uuid":"${target}"`)).toBe(
      content.length - WINDOW - 1,
    )

    await removeTranscriptMessage(target)

    expect(await readFile(sessionFile, 'utf8')).toBe(head + tail)
  })

  test('does not match a UUID that only appears as parentUuid', async () => {
    const orphan = uuidOf(2)
    const content =
      `{"uuid":"${uuidOf(1)}","parentUuid":"${orphan}","text":"child"}\n` +
      `{"uuid":"${uuidOf(3)}","logicalParentUuid":"${orphan}","text":"other"}\n`
    await writeFile(sessionFile, content)

    await removeTranscriptMessage(orphan)

    expect(await readFile(sessionFile, 'utf8')).toBe(content)
  })

  test('does not match a UUID quoted inside message content', async () => {
    // JSON escaping renders an embedded key as \"uuid\":\", which the raw
    // byte needle cannot match.
    const orphan = uuidOf(2)
    const content = line(uuidOf(1), `look: {"uuid":"${orphan}"} in prose`)
    await writeFile(sessionFile, content)

    await removeTranscriptMessage(orphan)

    expect(await readFile(sessionFile, 'utf8')).toBe(content)
  })

  test('is a no-op when the uuid is absent', async () => {
    const content = line(uuidOf(1), 'first') + line(uuidOf(2), 'second')
    await writeFile(sessionFile, content)

    await removeTranscriptMessage(uuidOf(9))

    expect(await readFile(sessionFile, 'utf8')).toBe(content)
  })

  test('is a no-op on an empty file', async () => {
    await writeFile(sessionFile, '')

    await removeTranscriptMessage(uuidOf(1))

    expect(await readFile(sessionFile, 'utf8')).toBe('')
  })

  test('handles a final entry written without a trailing newline', async () => {
    const head = line(uuidOf(1), 'first')
    await writeFile(sessionFile, head + line(uuidOf(2), 'orphan').trimEnd())

    await removeTranscriptMessage(uuidOf(2))

    expect(await readFile(sessionFile, 'utf8')).toBe(head)
  })
})

// drainWriteQueue accumulates serialized entries and appends them once the
// batch reaches MAX_CHUNK_BYTES. That cap dropped from 100 MB to 4 MB to bound
// the flatten-and-encode transient, which means the multi-chunk branch — dead
// code in practice at 100 MB — is now genuinely reachable. Pin it: a drain
// that spans chunks has to produce the same transcript as one that does not.

describe('drainWriteQueue across a chunk boundary', () => {
  let sessionFile: string
  let originalConfigDir: string | undefined
  let originalTestPersistence: string | undefined

  beforeEach(() => {
    mkdirSync(join(tempDir, 'projects'), { recursive: true })
    sessionFile = join(tempDir, 'projects', 'drain.jsonl')

    originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = tempDir
    // Project.shouldSkipPersistence() short-circuits every write when
    // NODE_ENV === 'test' unless this opt-in is set.
    originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'

    resetProjectForTesting()
    setSessionFileForTesting(sessionFile)
  })

  afterEach(async () => {
    await flushSessionStorage()
    resetProjectForTesting()
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    if (originalTestPersistence === undefined) {
      delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
    } else {
      process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
    }
  })

  afterAll(() => {
    resetProjectForTesting()
  })

  test('writes every entry when the batch spans several chunks', async () => {
    // 60 x 96 KB is ~5.8 MB, so the 4 MB cap forces at least one mid-batch
    // flush. Single-character repeat: a multi-character one would be a JSC
    // rope that never allocates, and the batch would not actually get large.
    const count = 60
    const messages = Array.from({ length: count }, (_, i) => ({
      type: i % 2 === 0 ? 'user' : 'assistant',
      uuid: uuidOf(i + 1),
      message:
        i % 2 === 0
          ? { role: 'user', content: 'q'.repeat(96 * 1024) }
          : {
              role: 'assistant',
              content: [{ type: 'text', text: 'r'.repeat(96 * 1024) }],
            },
    }))

    await recordTranscript(
      messages as unknown as Parameters<typeof recordTranscript>[0],
    )
    await flushSessionStorage()

    const { messages: loaded } = await loadTranscriptFile(sessionFile)

    expect(loaded.size).toBe(count)
    // Order and content survive the flush seam.
    expect([...loaded.keys()]).toEqual(
      Array.from({ length: count }, (_, i) => uuidOf(i + 1)),
    )
    const first = loaded.get(uuidOf(1))
    const last = loaded.get(uuidOf(count))
    expect(first?.message?.content).toBe('q'.repeat(96 * 1024))
    expect(last?.message?.content).toEqual([
      { type: 'text', text: 'r'.repeat(96 * 1024) },
    ])
  }, 60_000)
})
