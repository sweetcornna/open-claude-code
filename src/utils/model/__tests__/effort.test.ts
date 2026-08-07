import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { makeSharedModuleMock } from '../../../../tests/mocks/sharedModuleMock.js'
import * as realSettings from 'src/utils/settings/settings.js'

const settingsMock = makeSharedModuleMock(
  'src/utils/settings/settings.js',
  realSettings,
).setup({
  getInitialSettings: () => ({ modelType: 'openai' }),
})

const { getDefaultEffortForModel } = await import('../effort.js')
const savedUserType = process.env.USER_TYPE

afterEach(() => {
  delete process.env.USER_TYPE
})

afterAll(() => {
  settingsMock.reset()
  if (savedUserType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = savedUserType
})

describe('OpenAI model effort defaults', () => {
  // These used to assert low / medium, which came from
  // getDefaultOpenAIReasoningEffort. The per-tier layer now supplies the
  // default for every model that supports effort, and GPT's factory value is
  // `xhigh` — a deliberate behaviour change, called out in the CHANGELOG
  // because it raises reasoning-token spend for GPT users. The old
  // sol-vs-terra split survives only as the fallback for models where
  // modelSupportsEffort() is false.
  test('gpt-5.6-sol variants take the GPT family default', () => {
    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBe('xhigh')
    expect(getDefaultEffortForModel('gpt-5.6-sol-preview')).toBe('xhigh')
  })

  test('gpt-5.6-terra takes the same family default', () => {
    expect(getDefaultEffortForModel('gpt-5.6-terra')).toBe('xhigh')
  })
})
