import type {
  PermissionBehavior,
  PermissionRule,
  PermissionRuleSource,
  ToolPermissionContext,
} from '@open-claude-code/tool-runtime/types/permissions.js'
import { permissionRuleValueFromString } from './permissionRuleParser.js'

const PERMISSION_RULE_SOURCES = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
  'cliArg',
  'command',
  'session',
] as const satisfies readonly PermissionRuleSource[]

export function getRuleByContentsForToolName(
  context: ToolPermissionContext,
  toolName: string,
  behavior: PermissionBehavior,
): Map<string, PermissionRule> {
  const rulesBySource =
    behavior === 'allow'
      ? context.alwaysAllowRules
      : behavior === 'deny'
        ? context.alwaysDenyRules
        : context.alwaysAskRules
  const rulesByContent = new Map<string, PermissionRule>()

  for (const source of PERMISSION_RULE_SOURCES) {
    for (const ruleString of rulesBySource[source] ?? []) {
      const ruleValue = permissionRuleValueFromString(ruleString)
      if (
        ruleValue.toolName === toolName &&
        ruleValue.ruleContent !== undefined
      ) {
        rulesByContent.set(ruleValue.ruleContent, {
          source,
          ruleBehavior: behavior,
          ruleValue,
        })
      }
    }
  }

  return rulesByContent
}
