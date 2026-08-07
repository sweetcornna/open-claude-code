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
import { authMock } from '../../../../../../tests/mocks/auth'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'
import { setupOauthClientMock } from '../../../../../../tests/mocks/oauthClient.js'
import { setupRemoteTriggerAuditMock } from '../../../../../../tests/mocks/remoteTriggerAudit.js'
import { setupConstantsOauthMock } from '../../../../../../tests/mocks/constantsOauth.js'

let requestStatus = 200
const auditRecords: Record<string, unknown>[] = []

const axiosHandle = setupAxiosMock()
axiosHandle.stubs.request = async () => ({
  status: requestStatus,
  data: { ok: requestStatus >= 200 && requestStatus < 300 },
})

beforeAll(() => {
  axiosHandle.useStubs = true
})
afterAll(() => {
  axiosHandle.useStubs = false
})

mock.module('src/utils/auth/auth.js', authMock)

const oauthClientMock = setupOauthClientMock({
  getOrganizationUUID: async () => 'org',
})
afterAll(() => oauthClientMock.reset())

// Narrow mock for the side-effectful entries in `src/constants/oauth.js`.
// Pure data exports (ALL_OAUTH_SCOPES, CLAUDE_AI_*_SCOPE, etc.) come from
// the real module and are not mocked, per the test policy that constants
// modules without side effects should not be replaced wholesale.
const constantsOauthMock = setupConstantsOauthMock({
  fileSuffixForOauthConfig: () => '',
  getOauthConfig: () => ({ BASE_API_URL: 'https://example.test' }),
})
afterAll(() => constantsOauthMock.reset())

// Recording stub, not a no-op: the suite asserts on both the returned
// `auditId` and the record contents. Kept as an override on the complete
// surface so the module's other exports stay real for later files.
const remoteTriggerAuditMock = setupRemoteTriggerAuditMock({
  appendRemoteTriggerAuditRecord: async record => {
    const fullRecord = {
      auditId: `audit-${auditRecords.length + 1}`,
      createdAt: Date.now(),
      ...record,
    }
    auditRecords.push(fullRecord)
    return fullRecord
  },
})
afterAll(() => remoteTriggerAuditMock.reset())

beforeEach(() => {
  requestStatus = 200
  auditRecords.length = 0
})

afterEach(() => {
  auditRecords.length = 0
})

describe('RemoteTriggerTool audit', () => {
  test('writes an audit record for successful remote calls', async () => {
    const { RemoteTriggerTool } = await import('../RemoteTriggerTool')
    const result = await RemoteTriggerTool.call(
      { action: 'run', trigger_id: 'trigger-1' },
      { abortController: new AbortController() } as any,
    )

    expect(result.data.audit_id).toBeString()
    expect(result.data.audit_id).toBe('audit-1')
    expect(auditRecords).toHaveLength(1)
    expect(auditRecords[0]).toMatchObject({
      action: 'run',
      triggerId: 'trigger-1',
      ok: true,
      status: 200,
    })
  })

  test('writes an audit record before rethrowing validation failures', async () => {
    const { RemoteTriggerTool } = await import('../RemoteTriggerTool')

    await expect(
      RemoteTriggerTool.call({ action: 'run' }, {
        abortController: new AbortController(),
      } as any),
    ).rejects.toThrow('run requires trigger_id')

    expect(auditRecords).toHaveLength(1)
    expect(auditRecords[0]).toMatchObject({
      action: 'run',
      ok: false,
      error: 'run requires trigger_id',
    })
  })
})
