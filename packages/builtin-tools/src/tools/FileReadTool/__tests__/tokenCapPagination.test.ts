import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { FileReadTool } = await import('../FileReadTool.js')
const { getReadTruncationNotice } = await import('../truncationNotice.js')
const { FILE_UNCHANGED_STUB, TRUNCATED_PARTIAL_VIEW_PREFIX } = await import(
  '../constants.js'
)
const { FileStateCache } = await import(
  '@open-claude-code/tool-runtime/fileStateCache.js'
)

type TextResult = {
  type: 'text'
  file: {
    filePath: string
    content: string
    numLines: number
    startLine: number
    totalLines: number
    truncatedByTokenCap?: boolean
  }
}
type UnchangedResult = { type: 'file_unchanged'; file: { filePath: string } }
type ReadResult = TextResult | UnchangedResult

// The cap is expressed in tokens; validateContentTokens rejects on bytes >
// maxTokens * 4 before any network call, so a 40-token cap means anything
// over 160 bytes is oversized without touching countTokensWithAPI.
const MAX_TOKENS = 40

let tmpDir: string
let previousSimple: string | undefined

function makeContext(readFileState: InstanceType<typeof FileStateCache>) {
  return {
    readFileState,
    fileReadingLimits: {
      maxTokens: MAX_TOKENS,
      maxSizeBytes: 10 * 1024 * 1024,
    },
    abortController: new AbortController(),
  }
}

async function read(
  input: { file_path: string; offset?: number; limit?: number },
  readFileState: InstanceType<typeof FileStateCache>,
): Promise<ReadResult> {
  const result = await (
    FileReadTool as unknown as {
      call: (input: unknown, context: unknown) => Promise<{ data: ReadResult }>
    }
  ).call(input, makeContext(readFileState))
  return result.data
}

function mapped(data: ReadResult): string {
  const block = (
    FileReadTool as unknown as {
      mapToolResultToToolResultBlockParam: (
        data: unknown,
        id: string,
      ) => { content: string }
    }
  ).mapToolResultToToolResultBlockParam(data, 'toolu_test')
  return block.content
}

beforeAll(() => {
  previousSimple = process.env.CLAUDE_CODE_SIMPLE
  // Skips the skill-discovery fan-out in call(); irrelevant to this behavior
  // and it touches the real filesystem.
  process.env.CLAUDE_CODE_SIMPLE = '1'
  tmpDir = mkdtempSync(join(tmpdir(), 'occ-read-tokencap-'))
})

afterAll(() => {
  if (previousSimple === undefined) delete process.env.CLAUDE_CODE_SIMPLE
  else process.env.CLAUDE_CODE_SIMPLE = previousSimple
  rmSync(tmpDir, { recursive: true, force: true })
})

function writeLines(name: string, lineCount: number): string {
  const filePath = join(tmpDir, name)
  const lines = Array.from(
    { length: lineCount },
    (_, i) => `line ${i + 1} ${'x'.repeat(40)}`,
  )
  writeFileSync(filePath, lines.join('\n'))
  return filePath
}

describe('FileReadTool token-cap auto-pagination', () => {
  test('whole-file read over the token cap returns a first page instead of throwing', async () => {
    const filePath = writeLines('big.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const data = await read({ file_path: filePath }, state)

    expect(data.type).toBe('text')
    const text = data as TextResult
    expect(text.file.truncatedByTokenCap).toBe(true)
    expect(text.file.totalLines).toBe(200)
    expect(text.file.numLines).toBeGreaterThan(0)
    expect(text.file.numLines).toBeLessThan(200)
    expect(text.file.startLine).toBe(1)
    // Page 1 really is the head of the file.
    expect(text.file.content.startsWith('line 1 ')).toBe(true)
  })

  test('the paginated read carries a banner naming the exact next-page call', async () => {
    const filePath = writeLines('banner.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const data = await read({ file_path: filePath }, state)
    const banner = getReadTruncationNotice(data as unknown as object)

    expect(banner).toBeDefined()
    expect(banner!.startsWith(TRUNCATED_PARTIAL_VIEW_PREFIX)).toBe(true)
    const numLines = (data as TextResult).file.numLines
    expect(banner).toContain(`showing lines 1-${numLines} of 200 total`)
    expect(banner).toContain(
      `Call Read with offset=${numLines + 1} limit=${numLines} for the next page`,
    )
    expect(banner).toContain('Do NOT answer from this page alone')
  })

  test('re-reading a truncated file returns the page again, never FILE_UNCHANGED_STUB', async () => {
    const filePath = writeLines('dedup.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const first = await read({ file_path: filePath }, state)
    expect((first as TextResult).file.truncatedByTokenCap).toBe(true)

    // Identical call, file untouched on disk: the dedup path would otherwise
    // match on offset+limit+mtime and collapse this into the stub, hiding
    // every page after the first.
    const second = await read({ file_path: filePath }, state)

    expect(second.type).toBe('text')
    expect(mapped(second)).not.toContain(FILE_UNCHANGED_STUB)
    expect((second as TextResult).file.truncatedByTokenCap).toBe(true)
  })

  test('the offset/limit the banner prescribes returns the next page', async () => {
    const filePath = writeLines('page2.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const first = (await read({ file_path: filePath }, state)) as TextResult
    const pageSize = first.file.numLines

    const second = (await read(
      { file_path: filePath, offset: pageSize + 1, limit: pageSize },
      state,
    )) as TextResult

    expect(second.type).toBe('text')
    expect(second.file.startLine).toBe(pageSize + 1)
    expect(second.file.content.startsWith(`line ${pageSize + 1} `)).toBe(true)
    // Page 2 is fresh content, not a stub and not a repeat of page 1.
    expect(second.file.content).not.toBe(first.file.content)
  })

  test('a truncated read marks readFileState partial so Edit/Write must re-read', async () => {
    const filePath = writeLines('partial.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    await read({ file_path: filePath }, state)

    expect(state.get(filePath)?.isPartialView).toBe(true)
  })

  test('an explicit ranged read over the cap still throws (unchanged)', async () => {
    const filePath = writeLines('ranged.txt', 200)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    await expect(
      read({ file_path: filePath, offset: 1, limit: 200 }, state),
    ).rejects.toThrow(/exceeds maximum allowed tokens/)
  })

  test('a single-huge-line file falls back to a character excerpt', async () => {
    const filePath = join(tmpDir, 'oneline.txt')
    writeFileSync(filePath, 'y'.repeat(20000))
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const data = (await read({ file_path: filePath }, state)) as TextResult

    expect(data.file.truncatedByTokenCap).toBe(true)
    expect(data.file.content.length).toBeLessThan(20000)
    const banner = getReadTruncationNotice(data as unknown as object)
    expect(banner).toContain('cannot be paginated by line')
  })

  test('a file under the cap is untouched and still dedups', async () => {
    const filePath = writeLines('small.txt', 2)
    const state = new FileStateCache(100, 25 * 1024 * 1024)

    const first = (await read({ file_path: filePath }, state)) as TextResult
    expect(first.file.truncatedByTokenCap).toBeUndefined()
    expect(getReadTruncationNotice(first as unknown as object)).toBeUndefined()

    const second = await read({ file_path: filePath }, state)
    expect(second.type).toBe('file_unchanged')
    expect(mapped(second)).toBe(FILE_UNCHANGED_STUB)
  })
})
