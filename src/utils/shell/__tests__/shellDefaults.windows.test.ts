/**
 * Windows default shell: PowerShell tool on by default; ! routing prefers it.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import * as realPlatform from 'src/utils/process/platform.js'
import { setupSettingsMock } from '../../../../tests/mocks/settings.js'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'

const settingsState: { defaultShell?: 'bash' | 'powershell' } = {}

// Shared complete-surface mock, scoped to this suite. A bare
// `{ getInitialSettings }` surface would blank out every other settings export
// for the rest of the process — mock.module is global and last-write-wins.
const settingsMock = setupSettingsMock()
beforeAll(() =>
  settingsMock.set({ getInitialSettings: () => ({ ...settingsState }) }),
)
afterAll(() => settingsMock.reset())

// Force windows platform for these unit tests regardless of host OS — again
// scoped, and again complete-surface. Left installed for the process this
// would (a) blank out getWslVersion/getLinuxDistroInfo/detectVcs and (b) make
// every later file in the src/utils shard believe it is running on Windows.
const platformMock = makeSharedModuleMock(
  'src/utils/process/platform.js',
  realPlatform,
).setup()
beforeAll(() => platformMock.set({ getPlatform: () => 'windows' as const }))
afterAll(() => platformMock.reset())

import { isPowerShellToolEnabled } from '../shellToolUtils.js'
import { resolveDefaultShell } from '../resolveDefaultShell.js'

const ENV_KEY = 'CLAUDE_CODE_USE_POWERSHELL_TOOL'
let savedEnv: string | undefined

beforeEach(() => {
  savedEnv = process.env[ENV_KEY]
  delete process.env[ENV_KEY]
  delete settingsState.defaultShell
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = savedEnv
  delete settingsState.defaultShell
})

describe('isPowerShellToolEnabled (windows)', () => {
  test('enabled by default when env unset', () => {
    expect(isPowerShellToolEnabled()).toBe(true)
  })

  test('disabled when env is falsy', () => {
    process.env[ENV_KEY] = '0'
    expect(isPowerShellToolEnabled()).toBe(false)
    process.env[ENV_KEY] = 'false'
    expect(isPowerShellToolEnabled()).toBe(false)
  })

  test('enabled when env is truthy', () => {
    process.env[ENV_KEY] = '1'
    expect(isPowerShellToolEnabled()).toBe(true)
  })
})

describe('resolveDefaultShell (windows)', () => {
  test('defaults to powershell when tool enabled and no settings', () => {
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('honors settings.defaultShell=bash', () => {
    settingsState.defaultShell = 'bash'
    expect(resolveDefaultShell()).toBe('bash')
  })

  test('honors settings.defaultShell=powershell', () => {
    settingsState.defaultShell = 'powershell'
    expect(resolveDefaultShell()).toBe('powershell')
  })

  test('falls back to bash when PowerShell tool is disabled', () => {
    process.env[ENV_KEY] = '0'
    expect(resolveDefaultShell()).toBe('bash')
  })
})
