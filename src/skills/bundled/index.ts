import { feature } from 'bun:bundle'
import { registerBatchSkill } from './batch.js'
import { registerDebugSkill } from './debug.js'
import { registerExplainUsageSkill } from './explainUsage.js'
import { registerFewerPermissionPromptsSkill } from './fewerPermissionPrompts.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerLoremIpsumSkill } from './loremIpsum.js'
import { registerRememberSkill } from './remember.js'
import { registerSimplifySkill } from './simplify.js'
import { registerUseArtifactsSkill } from './useArtifacts.js'
import { registerSkillifySkill } from './skillify.js'
import { registerCronDeleteSkill, registerCronListSkill } from './cronManage.js'
import { registerLoopSkill } from './loop.js'
import { registerDreamSkill } from './dream.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import { registerVerifySkill } from './verify.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  registerVerifySkill()
  registerDebugSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  registerUseArtifactsSkill()
  registerBatchSkill()
  registerExplainUsageSkill()
  registerFewerPermissionPromptsSkill()
  if (feature('WORKFLOW_SCRIPTS')) {
    // The whole skill is a manual for the Workflow tool. With WORKFLOW_SCRIPTS
    // compiled out that tool does not exist, so registering it would advertise
    // and document a tool the model cannot call.
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerUltracodeSkill } = require('./ultracode.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerUltracodeSkill()
  }
  registerLoopSkill()
  registerCronListSkill()
  registerCronDeleteSkill()
  registerDreamSkill()
  if (feature('AGENT_TRIGGERS_REMOTE')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const {
      registerScheduleRemoteAgentsSkill,
    } = require('./scheduleRemoteAgents.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerScheduleRemoteAgentsSkill()
  }
  if (feature('BUILDING_CLAUDE_APPS')) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { registerClaudeApiSkill } = require('./claudeApi.js')
    /* eslint-enable @typescript-eslint/no-require-imports */
    registerClaudeApiSkill()
  }
}
