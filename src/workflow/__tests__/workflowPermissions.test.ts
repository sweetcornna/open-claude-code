import { expect, test } from 'bun:test'
import { getEmptyToolPermissionContext } from '../../Tool.js'
import type { ToolUseContext } from '../../Tool.js'
import { createWorkflowToolCore } from '../wiring.js'

function contextWithRules(rules: {
  allow?: string[]
  ask?: string[]
  deny?: string[]
}): ToolUseContext {
  const permissionContext = {
    ...getEmptyToolPermissionContext(),
    alwaysAllowRules: { localSettings: rules.allow ?? [] },
    alwaysAskRules: { localSettings: rules.ask ?? [] },
    alwaysDenyRules: { localSettings: rules.deny ?? [] },
  }
  return {
    getAppState: () => ({ toolPermissionContext: permissionContext }),
  } as unknown as ToolUseContext
}

test('named workflow rules apply only to the exact named workflow', async () => {
  const tool = createWorkflowToolCore()
  const context = contextWithRules({ allow: ['Workflow(research)'] })

  await expect(
    tool.checkPermissions({ name: 'research' }, context),
  ).resolves.toMatchObject({
    behavior: 'allow',
    decisionReason: {
      type: 'rule',
      rule: { ruleValue: { ruleContent: 'research' } },
    },
  })
  await expect(
    tool.checkPermissions({ name: 'other' }, context),
  ).resolves.toMatchObject({
    behavior: 'ask',
    suggestions: [
      {
        rules: [{ toolName: 'Workflow', ruleContent: 'other' }],
      },
    ],
  })
  await expect(
    tool.checkPermissions({ script: 'return 1' }, context),
  ).resolves.toMatchObject({ behavior: 'ask' })
  await expect(
    tool.checkPermissions({ name: 'research', script: 'return 1' }, context),
  ).resolves.toMatchObject({ behavior: 'ask' })
})

test('workflow control operations do not inherit named run grants', async () => {
  const tool = createWorkflowToolCore()
  const context = contextWithRules({ allow: ['Workflow(research)'] })

  await expect(
    tool.checkPermissions({ operation: 'status', runId: 'run-1' }, context),
  ).resolves.toMatchObject({ behavior: 'allow' })
  await expect(
    tool.checkPermissions({ operation: 'cancel', runId: 'run-1' }, context),
  ).resolves.toMatchObject({
    behavior: 'ask',
    message: 'Review workflow cancellation',
  })
})

test('named workflow deny and ask rules retain their behavior', async () => {
  const tool = createWorkflowToolCore()

  await expect(
    tool.checkPermissions(
      { name: 'blocked' },
      contextWithRules({ deny: ['Workflow(blocked)'] }),
    ),
  ).resolves.toMatchObject({ behavior: 'deny' })
  await expect(
    tool.checkPermissions(
      { name: 'reviewed' },
      contextWithRules({ ask: ['Workflow(reviewed)'] }),
    ),
  ).resolves.toMatchObject({
    behavior: 'ask',
    decisionReason: { type: 'rule' },
  })
})
