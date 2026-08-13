import { describe, expect, mock, test } from 'bun:test'
import { logMock } from '../../../../../../tests/mocks/log'
import { debugMock } from '../../../../../../tests/mocks/debug'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const { GlobTool } = await import('../GlobTool.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

type Ctx = ReturnType<typeof getEmptyToolPermissionContext>

function contextWithReadDeny(deny: string[]): Ctx {
  return {
    ...getEmptyToolPermissionContext(),
    alwaysDenyRules: { localSettings: deny },
  } as Ctx
}

const getPath = (input: { pattern: string; path?: string }): string =>
  (
    GlobTool as unknown as {
      getPath: (i: { pattern: string; path?: string }) => string
    }
  ).getPath(input)

async function checkPerms(
  input: { pattern: string; path?: string },
  ctx: Ctx,
): Promise<{ behavior: string }> {
  return (
    GlobTool as unknown as {
      checkPermissions: (
        i: unknown,
        c: { getAppState: () => { toolPermissionContext: Ctx } },
      ) => Promise<{ behavior: string }>
    }
  ).checkPermissions(input, {
    getAppState: () => ({ toolPermissionContext: ctx }),
  })
}

describe('GlobTool getPath re-roots on absolute patterns', () => {
  test('absolute pattern → search root is the pattern base dir, not cwd', () => {
    // This is the path the permission layer evaluates. It must match where
    // ripgrep actually walks (glob() re-roots at the same base dir).
    expect(getPath({ pattern: '/Users/victim/.ssh/**' })).toBe(
      '/Users/victim/.ssh',
    )
  })

  test('absolute pattern base dir wins even when path is also provided', () => {
    expect(getPath({ pattern: '/etc/secrets/*.pem', path: '/repo' })).toBe(
      '/etc/secrets',
    )
  })

  test('relative pattern still falls back to path/cwd', () => {
    expect(getPath({ pattern: '**/*.ts', path: '/repo' })).toBe('/repo')
  })
})

describe('GlobTool permission enforcement on absolute patterns', () => {
  test('an absolute pattern into a read-denied directory is denied', async () => {
    const ctx = contextWithReadDeny([
      'Read(//tmp/occ-glob-deny-test/secret/**)',
    ])
    const decision = await checkPerms(
      { pattern: '/tmp/occ-glob-deny-test/secret/**' },
      ctx,
    )
    // Before the getPath fix this evaluated cwd (allowed) and leaked the deny.
    expect(decision.behavior).toBe('deny')
  })
})
