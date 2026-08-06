import { getChromeFlagOverride } from '../../bootstrap/state.js'
import {
  BROWSER_USE_READ_ONLY_TOOLS,
  BROWSER_USE_TOOL_PREFIX,
} from '../../utils/browserUse/common.js'
import { BROWSER_USE_SYSTEM_PROMPT } from '../../utils/browserUse/prompt.js'
import { shouldEnableBrowserTool } from '../../utils/browserUse/setup.js'
import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_ACTIVATION_MESSAGE = `
The browser tools are connected. Start with \`${BROWSER_USE_TOOL_PREFIX}browser_get_state\` to see what the browser has open and which elements are interactable.
`

export function registerBrowserUseSkill(): void {
  registerBundledSkill({
    name: 'browser-use',
    description:
      'Drives a real browser: reads page state, extracts content, navigates, clicks and types, manages tabs and sessions, and can hand a task to an autonomous browsing agent.',
    whenToUse:
      'When the user wants to inspect or automate a web page, reproduce a browser bug, see what a UI change actually renders as, or pull information out of a running site. Requires the session to have been started with --chrome.',
    // Deliberately the same observational subset that `--chrome` pre-approves.
    // A skill's allowedTools become always-allow rules, so listing the acting
    // tools here would quietly undo the permission gate the integration
    // depends on: this server drives a real, potentially logged-in browser.
    allowedTools: BROWSER_USE_READ_ONLY_TOOLS.map(
      name => `${BROWSER_USE_TOOL_PREFIX}${name}`,
    ),
    userInvocable: true,
    // Mirrors the decision rootAction made at startup, so the skill is offered
    // exactly when the server is actually attached.
    isEnabled: () => shouldEnableBrowserTool(getChromeFlagOverride()),
    async getPromptForCommand(args) {
      let prompt = `${BROWSER_USE_SYSTEM_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      if (args) {
        prompt += `\n## Task\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
