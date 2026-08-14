import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getEmptyToolPermissionContext } from '../../../Tool.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { validateDirectoryForWorkspace } from '../validation.js'

let root: string
let projectDir: string
let subDir: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'occ-add-dir-'))
  projectDir = join(root, 'realproj')
  subDir = join(projectDir, 'sub')
  mkdirSync(subDir, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function contextWith(workingDir: string): ToolPermissionContext {
  return {
    ...getEmptyToolPermissionContext(),
    additionalWorkingDirectories: new Map([
      [workingDir, { source: 'session' }],
    ]),
  } as unknown as ToolPermissionContext
}

describe('validateDirectoryForWorkspace containment check', () => {
  test('still recognises a path already inside a working directory', async () => {
    const result = await validateDirectoryForWorkspace(
      subDir,
      contextWith(projectDir),
    )
    expect(result.resultType).toBe('alreadyInWorkingDirectory')
  })

  test('does not fold case when deciding containment', async () => {
    // The requested path is the REAL directory, so stat() succeeds on every
    // platform; only the working-directory string differs in case, and that
    // string is compared, never resolved. So this assertion is independent of
    // whether the host filesystem is case-sensitive — which matters, because
    // on macOS the case-folding bug is invisible.
    //
    // Folding would report "already in <WORKING DIR>" and add nothing, leaving
    // the user with a directory they believe is in scope but which still
    // prompts for every operation.
    const result = await validateDirectoryForWorkspace(
      subDir,
      contextWith(join(root, 'REALPROJ')),
    )
    expect(result.resultType).toBe('success')
  })
})
