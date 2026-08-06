import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test'
import { join, resolve } from 'path'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('src/utils/telemetry/debug.ts', debugMock)

const {
  gracefulShutdown,
  isInstallTreeReplacedError,
  isShuttingDown,
  resetShutdownState,
} = await import('../gracefulShutdown.js')
const { distRoot } = await import('../../filesystem/distRoot.js')

const originalNodeEnv = process.env.NODE_ENV
const originalExitCode = process.exitCode
const projectRoot = resolve(__dirname, '..', '..', '..', '..')

class MockProcessExitError extends Error {
  constructor(readonly exitCode: string | number | null | undefined) {
    super(`process.exit(${exitCode})`)
  }
}

describe('gracefulShutdown', () => {
  beforeEach(() => {
    process.env.NODE_ENV = 'test'
    resetShutdownState()
  })

  afterEach(() => {
    resetShutdownState()
    process.exitCode = originalExitCode ?? 0
  })

  afterAll(() => {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = originalNodeEnv
    }
  })

  test('returns immediately when shutdown is already in progress', async () => {
    const firstExit = new MockProcessExitError(17)
    const exitSpy = spyOn(process, 'exit').mockImplementation(((
      _exitCode?: string | number | null,
    ): never => {
      throw firstExit
    }) as typeof process.exit)

    try {
      const firstShutdown = gracefulShutdown(17)
      expect(isShuttingDown()).toBe(true)

      await expect(gracefulShutdown(18)).resolves.toBeUndefined()
      await expect(firstShutdown).rejects.toBe(firstExit)
      expect(exitSpy).toHaveBeenCalledTimes(1)
      expect(exitSpy).toHaveBeenCalledWith(17)
    } finally {
      exitSpy.mockRestore()
    }
  })

  test('force exits when the hooks import fails', async () => {
    const script = `
      Bun.plugin({
        name: 'fail-graceful-shutdown-hooks',
        setup(build) {
          build.onResolve({ filter: /hooks\\.js$/ }, args => {
            if (args.importer.endsWith('/gracefulShutdown.ts')) {
              throw new Error('hooks import failed')
            }
            return undefined
          })
        },
      })
      const { gracefulShutdown } = await import(
        './src/utils/process/gracefulShutdown.ts'
      )
      await gracefulShutdown(23)
    `
    const proc = Bun.spawn(['bun', '-e', script], {
      cwd: projectRoot,
      env: { ...process.env, NODE_ENV: 'production' },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const exitCode = await proc.exited

    if (exitCode !== 23) {
      const stderr = await new Response(proc.stderr).text()
      const stdout = await new Response(proc.stdout).text()
      throw new Error(
        `shutdown subprocess exited with ${exitCode}:\n${stderr}\n${stdout}`,
      )
    }
  })
})

describe('isInstallTreeReplacedError', () => {
  // occ ships ~600 content-hashed chunks that are imported lazily for the whole
  // life of a session, so `npm|bun install -g` replacing the tree strands about
  // half of them. Recognizing that specific failure is what turns a wedged REPL
  // into "restart occ".
  const chunkPath = join(distRoot, 'chunks', 'repl-Ab3xY9.js')

  test('recognizes a vanished chunk reported by Node', () => {
    const error = Object.assign(
      new Error(`Cannot find module '${chunkPath}' imported from ${distRoot}`),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(isInstallTreeReplacedError(error)).toBe(true)
  })

  test("recognizes Bun's ResolveMessage for the same failure", () => {
    const error = new Error(`Cannot find module '${chunkPath}'`)
    error.name = 'ResolveMessage'
    expect(isInstallTreeReplacedError(error)).toBe(true)
  })

  test('ignores a module-not-found outside the chunk tree', () => {
    // A user plugin or MCP server failing to resolve must not kill the session.
    const error = Object.assign(
      new Error("Cannot find module '/home/u/.occ/plugins/thing/index.js'"),
      { code: 'ERR_MODULE_NOT_FOUND' },
    )
    expect(isInstallTreeReplacedError(error)).toBe(false)
  })

  test('ignores unrelated errors and non-errors', () => {
    expect(isInstallTreeReplacedError(new Error(chunkPath))).toBe(false)
    expect(isInstallTreeReplacedError(chunkPath)).toBe(false)
    expect(isInstallTreeReplacedError(undefined)).toBe(false)
  })
})
