import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let requestStatus = 200
const auditRecords: Record<string, unknown>[] = []

mock.module('axios', () => ({
  default: {
    request: async () => ({
      status: requestStatus,
      data: { ok: requestStatus >= 200 && requestStatus < 300 },
    }),
  },
}))

mock.module('src/utils/auth.js', () => ({
  checkAndRefreshOAuthTokenIfNeeded: async () => {},
  getClaudeAIOAuthTokens: () => ({ accessToken: 'token' }),
  isClaudeAISubscriber: () => true,
}))

mock.module('src/services/oauth/client.js', () => ({
  getOrganizationUUID: async () => 'org',
}))

mock.module('src/services/analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => true,
}))

mock.module('src/services/policyLimits/index.js', () => ({
  isPolicyAllowed: () => true,
}))

mock.module('src/constants/oauth.js', () => ({
  ALL_OAUTH_SCOPES: ['user:profile', 'user:inference'],
  CLAUDE_AI_INFERENCE_SCOPE: 'user:inference',
  CLAUDE_AI_OAUTH_SCOPES: ['user:profile', 'user:inference'],
  CLAUDE_AI_PROFILE_SCOPE: 'user:profile',
  CONSOLE_OAUTH_SCOPES: ['org:create_api_key', 'user:profile'],
  MCP_CLIENT_METADATA_URL: 'https://example.test/oauth/metadata',
  OAUTH_BETA_HEADER: 'oauth-test',
  fileSuffixForOauthConfig: () => '',
  getOauthConfig: () => ({ BASE_API_URL: 'https://example.test' }),
}))

mock.module('src/utils/remoteTriggerAudit.js', () => ({
  appendRemoteTriggerAuditRecord: async (
    record: Record<string, unknown>,
  ) => {
    const fullRecord = {
      auditId: `audit-${auditRecords.length + 1}`,
      createdAt: Date.now(),
      ...record,
    }
    auditRecords.push(fullRecord)
    return fullRecord
  },
}))

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
      RemoteTriggerTool.call(
        { action: 'run' },
        { abortController: new AbortController() } as any,
      ),
    ).rejects.toThrow('run requires trigger_id')

    expect(auditRecords).toHaveLength(1)
    expect(auditRecords[0]).toMatchObject({
      action: 'run',
      ok: false,
      error: 'run requires trigger_id',
    })
  })
})
