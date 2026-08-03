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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { occConfigDir } from 'src/config/paths.js'
import { setupAxiosMock } from '../../../../tests/mocks/axios.js'
import { debugMock } from '../../../../tests/mocks/debug.js'
import { logMock } from '../../../../tests/mocks/log.js'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const axiosHandle = setupAxiosMock()

const { resetStateForTests, setOriginalCwd, switchSession } = await import(
  '../../../bootstrap/state.js'
)
const { asSessionId } = await import('../../../types/ids.js')
const { getSessionLogs } = await import(
  '../../../services/api/sessionIngress.js'
)
const { hydrateRemoteSession } = await import('../hydration.js')
const { getTranscriptPathForSession } = await import('../paths.js')
const { resetProjectForTesting } = await import('../transcriptWriter.js')

const originalConfigDir = process.env.OCC_CONFIG_DIR
const originalToken = process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
let tempDir: string

beforeAll(() => {
  axiosHandle.useStubs = true
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'session-hydration-'))
  process.env.OCC_CONFIG_DIR = join(tempDir, 'config')
  process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = 'test-session-token'
  occConfigDir.cache.clear?.()
  setOriginalCwd(join(tempDir, 'project'))
  resetProjectForTesting()
})

afterEach(async () => {
  resetProjectForTesting()
  resetStateForTests()
  await rm(tempDir, { recursive: true, force: true })
})

afterAll(() => {
  axiosHandle.useStubs = false
  axiosHandle.stubs = {}
  if (originalConfigDir === undefined) delete process.env.OCC_CONFIG_DIR
  else process.env.OCC_CONFIG_DIR = originalConfigDir
  if (originalToken === undefined)
    delete process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN
  else process.env.CLAUDE_CODE_SESSION_ACCESS_TOKEN = originalToken
  occConfigDir.cache.clear?.()
})

describe('remote transcript hydration', () => {
  test('classifies authentication errors as fetch failures', async () => {
    axiosHandle.stubs.get = async () => ({
      status: 401,
      statusText: 'Unauthorized',
      data: {},
    })

    await expect(
      getSessionLogs('session-auth', 'https://example.test'),
    ).resolves.toEqual({ status: 'failure' })
  })

  test('preserves the local transcript when the remote fetch fails', async () => {
    axiosHandle.stubs.get = async () => ({
      status: 401,
      statusText: 'Unauthorized',
      data: {},
    })

    const sessionId = '11111111-1111-4111-8111-111111111111'
    switchSession(asSessionId(sessionId))
    const transcriptPath = getTranscriptPathForSession(sessionId)
    await mkdir(dirname(transcriptPath), { recursive: true })
    const localTranscript = '{"type":"user","uuid":"local"}\n'
    await writeFile(transcriptPath, localTranscript)

    await expect(
      hydrateRemoteSession(sessionId, 'https://example.test'),
    ).resolves.toBe(false)
    expect(await readFile(transcriptPath, 'utf8')).toBe(localTranscript)
  })

  test('still clears the local transcript when the remote confirms no session', async () => {
    axiosHandle.stubs.get = async () => ({
      status: 404,
      statusText: 'Not Found',
      data: {},
    })

    const sessionId = '22222222-2222-4222-8222-222222222222'
    switchSession(asSessionId(sessionId))
    const transcriptPath = getTranscriptPathForSession(sessionId)
    await mkdir(dirname(transcriptPath), { recursive: true })
    await writeFile(transcriptPath, '{"type":"user","uuid":"stale"}\n')

    await expect(
      hydrateRemoteSession(sessionId, 'https://example.test'),
    ).resolves.toBe(false)
    expect(await readFile(transcriptPath, 'utf8')).toBe('')
  })
})
