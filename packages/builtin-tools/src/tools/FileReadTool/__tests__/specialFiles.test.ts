import { describe, expect, mock, test } from 'bun:test'
import { debugMock } from '../../../../../../tests/mocks/debug'
import { logMock } from '../../../../../../tests/mocks/log'

mock.module('src/utils/telemetry/debug.ts', debugMock)
mock.module('src/utils/telemetry/log.ts', logMock)

const { FileReadTool } = await import('../FileReadTool.js')
const { getEmptyToolPermissionContext } = await import('src/Tool.js')

async function validate(filePath: string) {
  return (
    FileReadTool as unknown as {
      validateInput: (
        input: { file_path: string },
        context: { getAppState: () => { toolPermissionContext: unknown } },
      ) => Promise<{ result: boolean; message?: string; errorCode?: number }>
    }
  ).validateInput(
    { file_path: filePath },
    {
      getAppState: () => ({
        toolPermissionContext: getEmptyToolPermissionContext(),
      }),
    },
  )
}

describe('FileReadTool procfs guards', () => {
  for (const name of ['environ', 'cmdline', 'auxv', 'maps', 'mem', 'stat']) {
    test(`blocks /proc/<pid>/${name} before filesystem access`, async () => {
      const result = await validate(`/proc/123/${name}`)

      expect(result).toMatchObject({ result: false, errorCode: 9 })
      expect(result.message).toContain('may expose process secrets or memory')
    })

    test(`blocks /proc/self/${name} before filesystem access`, async () => {
      const result = await validate(`/proc/self/${name}`)

      expect(result).toMatchObject({ result: false, errorCode: 9 })
    })
  }

  test('does not block non-sensitive procfs metadata by path alone', async () => {
    const result = await validate('/proc/self/status')

    expect(result.result).toBe(true)
  })
})
