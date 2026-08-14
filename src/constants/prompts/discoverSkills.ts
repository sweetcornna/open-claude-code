import { feature } from 'bun:bundle'

// Dead code elimination: the require() is inside the feature() ternary so
// external builds constant-fold the whole branch away along with the tool
// name interpolation in the guidance string below.
/* eslint-disable @typescript-eslint/no-require-imports */
export const DISCOVER_SKILLS_TOOL_NAME: string | null = feature(
  'EXPERIMENTAL_SKILL_SEARCH',
)
  ? (
      require('@open-claude-code/builtin-tools/tools/DiscoverSkillsTool/prompt.js') as typeof import('@open-claude-code/builtin-tools/tools/DiscoverSkillsTool/prompt.js')
    ).DISCOVER_SKILLS_TOOL_NAME
  : null

// Capture the module (not .isSkillSearchEnabled directly) so spyOn() in tests
// patches what we actually call — a captured function ref would point past the spy.
const skillSearchFeatureCheck = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('../../services/skillSearch/featureCheck.js') as typeof import('../../services/skillSearch/featureCheck.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

export function isSkillSearchActive(): boolean {
  return skillSearchFeatureCheck?.isSkillSearchEnabled() ?? false
}

/**
 * Framing for the skill_discovery attachment ("Skills relevant to your task:")
 * and the DiscoverSkills tool.
 *
 * Shared between the main session and subagents: subagents receive
 * skill_discovery attachments but never go through getSystemPrompt, so without
 * this they would see the reminders with no explanation of what they are.
 */
export function getDiscoverSkillsGuidance(): string | null {
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    DISCOVER_SKILLS_TOOL_NAME !== null
  ) {
    return `Relevant skills are automatically surfaced each turn as "Skills relevant to your task:" reminders. If you're about to do something those don't cover — a mid-task pivot, an unusual workflow, a multi-step plan — call ${DISCOVER_SKILLS_TOOL_NAME} with a specific description of what you're doing. Skills already visible or loaded are filtered automatically. Skip this if the surfaced skills already cover your next action.`
  }
  return null
}
