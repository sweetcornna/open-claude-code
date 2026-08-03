import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { logMock } from '../../../../tests/mocks/log.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realExecFile from 'src/utils/process/execFileNoThrow.js'

mock.module('src/utils/telemetry/log.ts', logMock)
mock.module('bun:bundle', () => ({ feature: () => false }))

type CreateCall = {
  file: string
  args: string[]
  options: Parameters<typeof realExecFile.execFileNoThrow>[2]
}

const createCalls: CreateCall[] = []
const execFileMock = makeSharedModuleMock(
  'src/utils/process/execFileNoThrow.js',
  realExecFile,
).setup({
  execFileNoThrow: async (file, args, options) => {
    createCalls.push({ file, args, options })
    return {
      stdout: 'https://github.com/owner/repo/issues/123\n',
      stderr: '',
      code: 0,
    }
  },
})

let useIssueChildProcessStubs = false

const execFileStub = (
  _cmd: string,
  _args: string[],
  _opts: unknown,
  callback: (error: Error | null, stdout: string, stderr: string) => void,
): void => callback(null, 'true\n', '')

;(execFileStub as unknown as Record<symbol, unknown>)[
  promisify.custom as symbol
] = async (): Promise<{ stdout: string; stderr: string }> => ({
  stdout: 'true\n',
  stderr: '',
})

const wrappedExecFile = ((...args: unknown[]) => {
  if (useIssueChildProcessStubs) {
    return (execFileStub as (...values: unknown[]) => unknown)(...args)
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return (real.execFile as (...values: unknown[]) => unknown)(...args)
}) as unknown as Record<symbol, unknown> & ((...args: unknown[]) => unknown)

;(wrappedExecFile as Record<symbol, unknown>)[promisify.custom as symbol] = (
  cmd: string,
  args: string[],
  opts: unknown,
): Promise<{ stdout: string; stderr: string }> => {
  if (useIssueChildProcessStubs) {
    return Promise.resolve({ stdout: 'true\n', stderr: '' })
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return promisify(real.execFile as never)(cmd, args, opts) as Promise<{
    stdout: string
    stderr: string
  }>
}

mock.module('node:child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const real = require('node:child_process') as Record<string, unknown>
  return {
    ...real,
    default: real,
    execFile: wrappedExecFile as typeof real.execFile,
    execFileSync: ((cmd: string) => {
      if (!useIssueChildProcessStubs) {
        return (real.execFileSync as (file: string) => Buffer)(cmd)
      }
      return Buffer.from(
        cmd === 'git'
          ? 'https://github.com/owner/repo.git\n'
          : 'gh version 2.0\n',
      )
    }) as typeof real.execFileSync,
  }
})

type CallIssue = (args: string) => Promise<{ type: 'text'; value: string }>

async function getCallIssue(): Promise<CallIssue> {
  const { default: issue } = await import('../index.js')
  const loaded = await (
    issue as unknown as { load: () => Promise<{ call: CallIssue }> }
  ).load()
  return loaded.call
}

let testRoot: string

async function writeSensitiveTranscript(): Promise<void> {
  const { getOriginalCwd, getSessionId, resetStateForTests, setOriginalCwd } =
    await import('../../../bootstrap/state.js')
  const { getClaudeConfigHomeDir } = await import(
    '../../../utils/config/envUtils.js'
  )
  const { sanitizePath } = await import('../../../utils/filesystem/path.js')

  resetStateForTests()
  const projectDir = join(testRoot, 'project')
  mkdirSync(projectDir, { recursive: true })
  setOriginalCwd(projectDir)
  getClaudeConfigHomeDir.cache?.clear?.()

  const logDir = join(
    getClaudeConfigHomeDir(),
    'projects',
    sanitizePath(getOriginalCwd()),
  )
  mkdirSync(logDir, { recursive: true })
  writeFileSync(
    join(logDir, `${getSessionId()}.jsonl`),
    [
      JSON.stringify({
        role: 'user',
        content:
          'diagnostic marker at /Users/private/project/file.ts Authorization: Bearer bearer-super-secret-value',
      }),
      JSON.stringify({
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'API_KEY=api-key-super-secret-value while reproducing',
          },
          {
            type: 'tool_result',
            is_error: true,
            content:
              'failed in /opt/private/service/index.ts with token=tool-secret-value',
          },
        ],
      }),
    ].join('\n') + '\n',
  )
}

beforeAll(() => {
  useIssueChildProcessStubs = true
})

afterAll(() => {
  useIssueChildProcessStubs = false
  execFileMock.reset()
})

beforeEach(async () => {
  createCalls.length = 0
  testRoot = mkdtempSync(join(tmpdir(), 'issue-security-test-'))
  process.env.OCC_CONFIG_DIR = join(testRoot, 'occ')
  await writeSensitiveTranscript()
})

afterEach(async () => {
  const { getClaudeConfigHomeDir } = await import(
    '../../../utils/config/envUtils.js'
  )
  const { resetStateForTests } = await import('../../../bootstrap/state.js')
  resetStateForTests()
  getClaudeConfigHomeDir.cache?.clear?.()
  delete process.env.OCC_CONFIG_DIR
  rmSync(testRoot, { recursive: true, force: true })
})

describe('/issue context privacy', () => {
  test('excludes transcript by default and sends the issue body through stdin', async () => {
    const call = await getCallIssue()
    const result = await call('Default issue')

    expect(result.value).toContain('Issue created')
    expect(createCalls).toHaveLength(1)
    const request = createCalls[0]!
    expect(request.file).toBe('gh')
    expect(request.args).toContain('--body-file')
    expect(request.args).toContain('-')
    expect(request.args).not.toContain('--body')
    expect(request.args.join(' ')).not.toContain('diagnostic marker')
    expect(request.options?.stdin).toBe('pipe')
    expect(request.options?.input).not.toContain('diagnostic marker')
    expect(request.options?.input).not.toContain('bearer-super-secret-value')
    expect(request.options?.input).not.toContain('/Users/private')
  })

  test('shows a redacted preview without creating an issue', async () => {
    const call = await getCallIssue()
    const result = await call('--include-context Context issue')

    expect(createCalls).toHaveLength(0)
    expect(result.value).toContain('Issue context preview')
    expect(result.value).toContain('diagnostic marker')
    expect(result.value).toContain('[REDACTED]')
    expect(result.value).toContain('[REDACTED_PATH]')
    expect(result.value).not.toContain('bearer-super-secret-value')
    expect(result.value).not.toContain('api-key-super-secret-value')
    expect(result.value).not.toContain('tool-secret-value')
    expect(result.value).not.toContain('/Users/private')
    expect(result.value).toContain('No issue was created')
    expect(result.value).toMatch(/--confirm [a-f0-9]{12}/)
  })

  test('uploads only redacted context after explicit confirmation', async () => {
    const call = await getCallIssue()
    const preview = await call('--include-context Context issue')
    const previewId = preview.value.match(/--confirm ([a-f0-9]{12})/)?.[1]
    expect(previewId).toBeDefined()

    const result = await call(
      `--include-context --confirm ${previewId} Context issue`,
    )

    expect(result.value).toContain('Issue created')
    expect(createCalls).toHaveLength(1)
    const body = createCalls[0]?.options?.input ?? ''
    expect(body).toContain('diagnostic marker')
    expect(body).toContain('[REDACTED]')
    expect(body).toContain('[REDACTED_PATH]')
    expect(body).not.toContain('bearer-super-secret-value')
    expect(body).not.toContain('api-key-super-secret-value')
    expect(body).not.toContain('tool-secret-value')
    expect(body).not.toContain('/Users/private')
    expect(createCalls[0]?.args.join(' ')).not.toContain(body)
  })

  test('rejects a confirmation ID that was not issued for the current preview', async () => {
    const call = await getCallIssue()
    const result = await call(
      '--include-context --confirm 000000000000 Context issue',
    )

    expect(createCalls).toHaveLength(0)
    expect(result.value).toContain('confirmation ID was invalid')
    expect(result.value).toMatch(/--confirm [a-f0-9]{12}/)
  })
})
