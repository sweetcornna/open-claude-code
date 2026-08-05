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
  test('uses low for gpt-5.6-sol variants', () => {
    expect(getDefaultEffortForModel('gpt-5.6-sol')).toBe('low')
    expect(getDefaultEffortForModel('gpt-5.6-sol-preview')).toBe('low')
  })

  test('keeps gpt-5.6-terra at medium', () => {
    expect(getDefaultEffortForModel('gpt-5.6-terra')).toBe('medium')
  })
})
