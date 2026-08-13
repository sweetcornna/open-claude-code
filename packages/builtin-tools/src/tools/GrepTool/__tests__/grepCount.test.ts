import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

// GlobTool/UI reads GrepTool.renderToolResultMessage at module top-level, so
// the tools must initialize GlobTool-before-GrepTool (as primitiveTools.ts
// does) or a cold direct import of GrepTool hits a circular-import TDZ.
await import('../../GlobTool/GlobTool.js')
const { GrepTool } = await import('../GrepTool.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

function makeContext(): unknown {
  return {
    abortController: new AbortController(),
    getAppState: () => ({
      toolPermissionContext: getEmptyToolPermissionContext(),
    }),
  }
}

async function callGrep(input: Record<string, unknown>) {
  const result = await (
    GrepTool as unknown as {
      call: (
        i: unknown,
        c: unknown,
      ) => Promise<{ data: Record<string, unknown> }>
    }
  ).call(input, makeContext())
  return result.data
}

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'occ-grep-count-'))
  // Single file with 3 matching lines — the exact shape that regressed:
  // `rg -c PATTERN <single-file>` prints a bare `3` with no `path:` prefix.
  writeFileSync(join(dir, 'a.txt'), 'match\nmatch\nmatch\nother\n')
})

afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('GrepTool count mode', () => {
  test('single-file target reports the real count (regression: -H)', async () => {
    const data = await callGrep({
      pattern: 'match',
      path: join(dir, 'a.txt'),
      output_mode: 'count',
    })
    // Before the -H fix these both stayed 0 because the bare `3` failed the
    // `path:count` parse.
    expect(data.numMatches).toBe(3)
    expect(data.numFiles).toBe(1)
    // Content carries the path-prefixed count line, relativized.
    expect(String(data.content)).toContain(':3')
  })

  test('directory target still aggregates counts across files', async () => {
    writeFileSync(join(dir, 'b.txt'), 'match\nmatch\n')
    const data = await callGrep({
      pattern: 'match',
      path: dir,
      output_mode: 'count',
    })
    // a.txt (3) + b.txt (2) across 2 files.
    expect(data.numMatches).toBe(5)
    expect(data.numFiles).toBe(2)
  })
})

describe('GrepTool invalid regex', () => {
  test('surfaces an unparseable pattern as an error, not "no matches"', async () => {
    // `foo(` is an unclosed group → rg exits 2 with a usage error. Before the
    // fix this resolved to [] and the model was told "No files found".
    await expect(callGrep({ pattern: 'foo(', path: dir })).rejects.toThrow(
      /ripgrep rejected the pattern/,
    )
  })
})
