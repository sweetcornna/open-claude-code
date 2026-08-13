import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { FileWriteTool } = await import('../FileWriteTool.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')
const { createFileStateCacheWithSizeLimit } = await import(
  'src/utils/fileStateCache.js'
)

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>
type FileState = { content: string; timestamp: number; isPartialView?: boolean }

const FUTURE = Date.now() + 10 * 60 * 1000

function makeContext(opts: {
  denyRules?: string[]
  seed?: { path: string; state: FileState }
}) {
  const readFileState = createFileStateCacheWithSizeLimit(10)
  if (opts.seed) {
    readFileState.set(opts.seed.path, {
      offset: undefined,
      limit: undefined,
      ...opts.seed.state,
    })
  }
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(),
    ...(opts.denyRules
      ? { alwaysDenyRules: { localSettings: opts.denyRules } }
      : {}),
  } as Ctx
  return {
    getAppState: () => ({ toolPermissionContext }),
    readFileState,
  }
}

async function validate(
  input: { file_path: string; content: string },
  context: ReturnType<typeof makeContext>,
): Promise<{ result: boolean; message?: string; errorCode?: number }> {
  return (
    FileWriteTool as unknown as {
      validateInput: (
        i: unknown,
        c: unknown,
      ) => Promise<{ result: boolean; message?: string; errorCode?: number }>
    }
  ).validateInput(input, context)
}

let dir: string
let file: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-write-guard-'))
  file = join(dir, 'a.txt')
  writeFileSync(file, 'original\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('FileWriteTool read-before-write guard', () => {
  test('overwriting an existing file that was never read is rejected with the read-first message', async () => {
    const res = await validate(
      { file_path: file, content: 'new' },
      makeContext({}),
    )
    expect(res.result).toBe(false)
    expect(res.message).toBe(
      'File has not been read yet. Read it first before writing to it.',
    )
    expect(res.errorCode).toBe(2)
  })

  test('a partial-view entry does NOT satisfy read-before-write', async () => {
    const res = await validate(
      { file_path: file, content: 'new' },
      makeContext({
        seed: {
          path: file,
          state: {
            content: 'original\n',
            timestamp: FUTURE,
            isPartialView: true,
          },
        },
      }),
    )
    expect(res.result).toBe(false)
    expect(res.errorCode).toBe(2)
  })

  test('creating a brand-new (nonexistent) file does NOT require a prior read', async () => {
    const res = await validate(
      { file_path: join(dir, 'brand-new.txt'), content: 'hi' },
      makeContext({}),
    )
    expect(res.result).toBe(true)
  })

  test('a real prior read passes the guard', async () => {
    const res = await validate(
      { file_path: file, content: 'new' },
      makeContext({
        seed: {
          path: file,
          state: { content: 'original\n', timestamp: FUTURE },
        },
      }),
    )
    expect(res.result).toBe(true)
  })
})

describe('FileWriteTool read-deny enforcement', () => {
  test('a read-denied path cannot be written', async () => {
    const res = await validate(
      { file_path: file, content: 'new' },
      makeContext({ denyRules: [`Read(//${dir.replace(/^\//, '')}/**)`] }),
    )
    expect(res.result).toBe(false)
    expect(res.message).toBe(
      'File is covered by a Read deny rule in your permission settings and cannot be written.',
    )
    expect(res.errorCode).toBe(13)
  })
})
