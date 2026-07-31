import { getChromeFlagOverride } from '../../bootstrap/state.js'
import {
  CHROME_DEVTOOLS_READ_ONLY_TOOLS,
  CHROME_DEVTOOLS_TOOL_PREFIX,
} from '../../utils/chromeDevtools/common.js'
import { CHROME_DEVTOOLS_SYSTEM_PROMPT } from '../../utils/chromeDevtools/prompt.js'
import { shouldEnableChromeDevtools } from '../../utils/chromeDevtools/setup.js'
import { registerBundledSkill } from '../bundledSkills.js'

const SKILL_ACTIVATION_MESSAGE = `
The Chrome DevTools tools are connected. Start with \`${CHROME_DEVTOOLS_TOOL_PREFIX}list_pages\` to see what the browser has open, then \`${CHROME_DEVTOOLS_TOOL_PREFIX}take_snapshot\` on the page you need to work with.
`

export function registerChromeDevtoolsSkill(): void {
  registerBundledSkill({
    name: 'chrome-devtools',
    description:
      'Drives a Chrome browser over the DevTools protocol: navigates pages, clicks and types, captures accessibility snapshots and screenshots, reads console messages and network requests, and runs performance traces and Lighthouse audits.',
    whenToUse:
      'When the user wants to inspect or automate a web page, reproduce a browser bug, see what a UI change actually renders as, or read console and network output from a running site. Requires the session to have been started with --chrome.',
    // Deliberately the same observational subset that `--chrome` pre-approves.
    // A skill's allowedTools become always-allow rules, so listing the acting
    // tools here would quietly undo the permission gate the integration
    // depends on: this server drives the user's real, logged-in browser.
    allowedTools: CHROME_DEVTOOLS_READ_ONLY_TOOLS.map(
      name => `${CHROME_DEVTOOLS_TOOL_PREFIX}${name}`,
    ),
    userInvocable: true,
    // Mirrors the decision main.tsx made at startup, so the skill is offered
    // exactly when the server is actually attached.
    isEnabled: () => shouldEnableChromeDevtools(getChromeFlagOverride()),
    async getPromptForCommand(args) {
      let prompt = `${CHROME_DEVTOOLS_SYSTEM_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      if (args) {
        prompt += `\n## Task\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
